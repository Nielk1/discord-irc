import _ from 'lodash';
import irc from 'irc';
import logger from 'winston';
import discord from 'discord.js';
import extras from 'irc-colors';
import { ConfigurationError } from './errors';
import { validateChannelMapping } from './validators';

const REQUIRED_FIELDS = ['server', 'nickname', 'channelMapping', 'discordToken'];
const NICK_COLORS = ['light_blue', 'dark_blue', 'light_red', 'dark_red', 'light_green',
  'dark_green', 'magenta', 'light_magenta', 'orange', 'yellow', 'cyan', 'light_cyan'];

/**
 * An IRC bot, works as a middleman for all communication
 * @param {object} options - server, nickname, channelMapping, outgoingToken, incomingURL
 */
class Bot {
  constructor(options) {
    REQUIRED_FIELDS.forEach((field) => {
      if (!options[field]) {
        throw new ConfigurationError(`Missing configuration field ${field}`);
      }
    });

    validateChannelMapping(options.channelMapping);

    this.discord = new discord.Client({ autoReconnect: true });

    this.server = options.server;
    this.nickname = options.nickname;
    this.ircOptions = options.ircOptions;
    this.discordToken = options.discordToken;
    this.commandCharacters = options.commandCharacters || [];
    this.ircNickColor = options.ircNickColor !== false; // default to true
    this.channels = _.values(options.channelMapping);

    this.channelMapping = {};
    this.channelReMappingStatus = {};
    this.webhookMapping = {};

    this.versionRequests = {}; // what channel the version request is from, keyed by users
    this.versionRequestsAuto = {}; // what channel the version request is from, keyed by users
    this.namesRequestForVersion = false;

    this.topicRequestFromUser = false;
    this.namesRequestFromUser = false;

    // Remove channel passwords from the mapping and lowercase IRC channel names
    _.forOwn(options.channelMapping, (ircChan, discordChan) => {
      this.channelMapping[discordChan] = ircChan.split(' ')[0].toLowerCase();
    });

    _.forOwn(options.channelReMappingStatus, (discordChanAlt, discordChan) => {
      this.channelReMappingStatus[discordChan] = discordChanAlt;
    });

    _.forOwn(options.webhookMapping, (webhook, discordChan) => {
      this.webhookMapping[discordChan] = new discord.WebhookClient(webhook.split(' ')[0], webhook.split(' ')[1]);
    });

    this.invertedMapping = _.invert(this.channelMapping);
    this.autoSendCommands = options.autoSendCommands || [];
  }

  connect() {
    logger.debug('Connecting to IRC and Discord');
    this.discord.login(this.discordToken);

    const ircOptions = {
      userName: this.nickname,
      realName: this.nickname,
      channels: this.channels,
      floodProtection: true,
      floodProtectionDelay: 500,
      retryCount: 10,
      ...this.ircOptions
    };

    this.ircClient = new irc.Client(this.server, this.nickname, ircOptions);
    this.attachListeners();
  }

  attachListeners() {
    this.discord.on('ready', () => {
      logger.info('Connected to Discord');
    });

    this.ircClient.on('registered', (message) => {
      logger.info('Connected to IRC');
      logger.debug('Registered event: ', message);
      this.autoSendCommands.forEach((element) => {
        this.ircClient.send(...element);
      });
    });

    this.ircClient.on('error', (error) => {
      logger.error('Received error event from IRC', error);
    });

    this.discord.on('error', (error) => {
      logger.error('Received error event from Discord', error);
    });

    this.discord.on('warn', (warning) => {
      logger.warn('Received warn event from Discord', warning);
    });

    this.discord.on('message', (message) => {
      // Ignore bot messages and people leaving/joining
      this.sendToIRC(message);
    });

    //this.ircClient.on('message', this.sendToDiscord.bind(this));
    this.ircClient.on('message', (from, to, text, message) => {
      if (to && to == this.ircClient.nick && from && text && text.startsWith('bzone ') && this.versionRequestsAuto[from]) {
        const channel = this.versionRequestsAuto[from];
        this.versionRequestsAuto[from] = null;
        const textOut = `*${from} ${text.trim()}*`;
        this.sendToDiscord(null, channel, textOut, { useChannelRemap:true });
      } else if (to && to == this.ircClient.nick && from && text && text.startsWith('bzone ') && this.versionRequests[from]) {
        const channel = this.versionRequests[from];
        this.versionRequests[from] = null;
        //const textOut = `*${from} ${text.slice(8)}*`;
        const textOut = `*${from} ${text.trim()}*`;
        this.sendToDiscord(null, channel, textOut, { useChannelRemap:false });
      } else {
        this.sendToDiscord(from, to, text);
      }
    });

    this.ircClient.on('names', (channel, nicks) => {
      if (this.namesRequestForVersion) {
        this.namesRequestForVersion = false;
        const nickList = _.keys(nicks);
        if (nickList.length) {
          nickList.forEach((nick) =>  {
            if (this.ircClient.nick != nick) {
              this.versionRequests[nick] = channel;
              this.ircClient.ctcp(nick, 'privmsg', 'VERSION');
            }
          });
        }
      } else {
        const nickList = _.keys(nicks);
        if (nickList.length) {
          const text = `*${channel}* users: **${nickList.join(', ')}**`;
          if (this.namesRequestFromUser) {
            this.namesRequestFromUser = false;
            this.sendToDiscord(null, channel, text, { useChannelRemap:false });
          } else {
            this.sendToDiscord(null, channel, text, { useChannelRemap:true });
          }
        }
      }
    });

    this.ircClient.on('topic', (channel, topic, nick, message) => {
      const text = `*${channel} IRC topic:*  ${extras.stripColorsAndStyle(topic)}`;
      if (this.topicRequestFromUser) {
        this.topicRequestFromUser = false;
        this.sendToDiscord(null, channel, text, { useChannelRemap:false });
      } else {
        this.sendToDiscord(null, channel, text, { useChannelRemap:true });
      }
    });

    this.ircClient.on('ctcp', (from, to, text, type, message) => {
      if (from && text && text.startsWith('VERSION ') && this.versionRequestsAuto[from]) {
        const channel = this.versionRequestsAuto[from];
        this.versionRequestsAuto[from] = null;
        const textOut = `*${from} ${text.trim()}*`;
        this.sendToDiscord(null, channel, textOut, { useChannelRemap:true });
      } else if (from && text && text.startsWith('VERSION ') && this.versionRequests[from]) {
        const channel = this.versionRequests[from];
        this.versionRequests[from] = null;
        //const textOut = `*${from} ${text.slice(8)}*`;
        const textOut = `*${from} ${text.trim()}*`;
        this.sendToDiscord(null, channel, textOut, { useChannelRemap:false });
      }
    });

    this.ircClient.on('join', (channel, nick, message) => {
        var message = `*${nick} has joined*`;
        if (this.ircClient.nick != nick) {
          this.versionRequestsAuto[nick] = channel;
          this.ircClient.ctcp(nick, 'privmsg', 'VERSION');
        }
        this.sendToDiscord(null, channel, message, { useChannelRemap:true });
    });

    this.ircClient.on('part', (channel, nick, reason, message) => {
      var message = `*${nick} has left`;
      if(reason != null && reason.length > 0)
        message += ': ' + extras.stripColorsAndStyle(reason);
      message += `*`;
      this.sendToDiscord(null, channel, message, { useChannelRemap:true });
    });

    this.ircClient.on('quit', (nick, reason, channels, message) => {
      var message = `*${nick} has quit`;
      if(reason != null && reason.length > 0)
        message += ': ' + extras.stripColorsAndStyle(reason);
      message += `*`;
      channels.forEach((a) => {
        this.sendToDiscord(null, a, message, { useChannelRemap:true });
      });
    });

    this.ircClient.on('kick', (channel, nick, by, reason, message) => {
      var message = `*${nick} has been kicked by ${by}`;
      if(reason != null && reason.length > 0)
        message += ': ' + extras.stripColorsAndStyle(reason);
      message += `*`;
      this.sendToDiscord(null, channel, message, { useChannelRemap:true });
    });

    this.ircClient.on('kill', (nick, reason, channels, message) => {
      var message = `*${nick} was killed`;
      if(reason != null && reason.length > 0)
        message += ': ' + extras.stripColorsAndStyle(reason);
      message += `*`;
      channels.forEach((a) => {
        this.sendToDiscord(null, a, message, { useChannelRemap:true });
      });
    });

    this.ircClient.on('notice', (author, to, text) => {
      this.sendToDiscord(author, to, `*${text}*`);
    });

    this.ircClient.on('action', (author, to, text) => {
      this.sendToDiscord(author, to, `_${text}_`);
    });

    this.ircClient.on('invite', (channel, from) => {
      logger.debug('Received invite:', channel, from);
      if (!this.invertedMapping[channel]) {
        logger.debug('Channel not found in config, not joining:', channel);
      } else {
        this.ircClient.join(channel);
        logger.debug('Joining channel:', channel);
      }
    });

    if (logger.level === 'debug') {
      this.discord.on('debug', (message) => {
        logger.debug('Received debug event from Discord', message);
      });
    }
  }

  static getDiscordNicknameOnServer(user, guild) {
    const userDetails = guild.members.get(user.id);
    if (userDetails) {
      return userDetails.nickname || user.username;
    }
    return user.username;
  }

  parseText(message) {
    const text = message.mentions.users.reduce((content, mention) => {
      const displayName = Bot.getDiscordNicknameOnServer(mention, message.guild);
      return content.replace(`<@${mention.id}>`, `@${displayName}`)
             .replace(`<@!${mention.id}>`, `@${displayName}`)
             .replace(`<@&${mention.id}>`, `@${displayName}`);
    }, message.content);

    return text
      .replace(/\n|\r\n|\r/g, ' ')
      .replace(/<#(\d+)>/g, (match, channelId) => {
        const channel = this.discord.channels.get(channelId);
        return `#${channel.name}`;
      })
      .replace(/<(:\w+:)\d+>/g, (match, emoteName) => emoteName);
  }

  isCommandMessage(message) {
    return this.commandCharacters.indexOf(message[0]) !== -1;
  }

  parseCommand(text, ircChannel) {
    if (text === '!help') {
      const text = "```\r\n"+
      "!users     list of users connected to IRC\r\n"+
      "!topic     topic of IRC room\r\n"+
      "!versions  versions of users in the room\r\n"+
      "```";
      this.sendToDiscord(null, ircChannel, text);
      return true;
    } else if (text === '!users') {
      this.namesRequestFromUser = true;
      this.ircClient.send('NAMES', ircChannel);
      return true;
    } else if (text === '!topic') {
      this.topicRequestFromUser = true;
      this.ircClient.send('TOPIC', ircChannel);
      return true;
    } else if (text === '!versions') {
      this.namesRequestForVersion = true;
      this.ircClient.send('NAMES', ircChannel);
      return true;
    }
    return false;
  }

  sendToIRC(message) {
    const author = message.author;
    
    // Ignore messages sent by the bot itself:
    if (author.id === this.discord.user.id) return;

    // Ignore bot messages.  This might not be correct in a world of multi-proxy-bots, but for our use it works
    if (author.bot) return;

    const channelName = `#${message.channel.name}`;
    const ircChannel = this.channelMapping[channelName];

    logger.debug('Channel Mapping', channelName, this.channelMapping[channelName]);
    if (ircChannel) {
      const fromGuild = message.guild;
      const nickname = Bot.getDiscordNicknameOnServer(author, fromGuild);
      let text = this.parseText(message);
      let displayUsername = nickname;
      if (this.ircNickColor) {
        const colorIndex = (nickname.charCodeAt(0) + nickname.length) % NICK_COLORS.length;
        displayUsername = irc.colors.wrap(NICK_COLORS[colorIndex], nickname);
      }

      if (this.isCommandMessage(text)) {
        //const prelude = `Command sent from Discord by ${nickname}:`;
        if (this.parseCommand(text, ircChannel)) {
          //this.ircClient.say(ircChannel, prelude);
          //this.ircClient.say(ircChannel, text);
        }
      } else {
        if (text !== '') {
          text = `<${displayUsername}> ${text}`;
          logger.debug('Sending message to IRC', ircChannel, text);
          this.ircClient.say(ircChannel, text);
        }

        if (message.attachments && message.attachments.size) {
          message.attachments.forEach((a) => {
            const urlMessage = `<${displayUsername}> ${a.url}`;
            logger.debug('Sending attachment URL to IRC', ircChannel, urlMessage);
            this.ircClient.say(ircChannel, urlMessage);
          });
        }
      }
    }
  }

  sendToDiscord(author, channel, text, extra_options = {}) {
    var discordChannelName = this.invertedMapping[channel.toLowerCase()];
    if (discordChannelName) {
      // #channel -> channel before retrieving and select only text channels:
      const discordChannel = this.discord.channels
        .filter(c => c.type === 'text')
        .find('name', discordChannelName.slice(1));

      if (!discordChannel) {
        logger.info('Tried to send a message to a channel the bot isn\'t in: ',
          discordChannelName);
        return;
      }

      const withMentions = text.replace(/@[^\s]+\b/g, (match) => {
        const search = match.substring(1);
        const guild = discordChannel.guild;
        const nickUser = guild.members.find('nickname', search);
        if (nickUser) {
          return nickUser;
        }

        const user = this.discord.users.find('username', search);
        if (user) {
          const nickname = guild.members.get(user.id).nickname;
          if (!nickname || nickname === search) {
            return user;
          }
        }

        return match;
      });

      if (extra_options.useChannelRemap && this.channelReMappingStatus[discordChannelName]) {
        discordChannelName = this.channelReMappingStatus[discordChannelName];      
      }

      const webhook = this.webhookMapping[discordChannelName];
      if (webhook) {
        if (!author) {
          webhook.name = channel.toLowerCase();
        } else {
          webhook.name = channel.toLowerCase() + " | " + author;
        }
        webhook.sendMessage(withMentions);
      } else {
        var withAuthor = withMentions;
        if (!author) {
          withAuthor = `${channel} ${withMentions}`;
        } else {
          // Add bold formatting:
          withAuthor = `${channel} **<${author}>** ${withMentions}`;
        }
        logger.debug('Sending message to Discord', withAuthor, channel, '->', discordChannelName);
        discordChannel.sendMessage(withAuthor);
      }
    }
  }
}

export default Bot;
