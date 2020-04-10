const osu = require('node-os-utils')
const nodemailer = require('nodemailer');

const PLUGIN_ID = 'signalk-healthcheck'
const PLUGIN_NAME = 'Healthcheck Service'

module.exports = function(app) {
  var plugin = {};
  var hostTimer;
  var providerTimers = [];
  var hostFailureCount = {
    "cpu": 0,
    "memory": 0,
    "disk": 0
  };
  var providersFailureCount = {};
  var hostFailureEmailSent = false;
  var providersFailureEmailSent = {};
  var hcOptions = {};

  plugin.id = PLUGIN_ID;
  plugin.name = PLUGIN_NAME;
  plugin.description = 'Plugin that provides a healthcheck service for SignalK.';

  function updateProviderSchema(schema) {
    let providerSchema = {
      type: 'object',
      title: 'Providers',
      properties: {}
    };

    let providers = app.config.settings.pipedProviders;

    providers.forEach(provider => {
      var obj = {
        type: 'object',
        title: provider.id,
        properties: {
          enabled: {
            title: 'Enabled',
            type: 'boolean',
            default: false
          },
          deltaWarning: {
            type: 'number',
            title: 'Expected deltas/s Warning Threshold',
            description: '',
            default: 1
          },
          deltaAlarm: {
            type: 'number',
            title: 'Expected deltas/s Alarm Threshold',
            description: '',
            default: 1
          },
          checkFrequency: {
            type: 'number',
            title: 'Check Frequency',
            description: 'How often to check the provider deltas (seconds).',
            default: 60
          },
          checkMaxAttempts: {
            type: 'number',
            title: 'Check Attempts',
            description: 'Number of failed checks before raising a notification.',
            default: 3
          },
          sendNotification: {
            type: 'boolean',
            title: 'Send Notification',
            default: false
          },
          sendEmail: {
            type: 'boolean',
            title: 'Send Email',
            default: false
          },
          toEmail: {
            type: 'string',
            title: 'Send Email To Address(es)',
            description: 'Comma separated list of recipients email addresses',
          }
        }
      }
      providerSchema.properties[provider.id] = obj;
    })

    schema.properties["providers"] = providerSchema;
    return schema;
  }

  plugin.schema = function() {
    var schema = {
      type: "object",
      title: "SignalK and Host Healthcheck",
      description: "If the plugin is enabled, then health state will always be available on-demand through the API. Optional configuration will take a proactive approach.",
      properties: {}
    };

    var obj = {
      type: 'object',
      title: 'Host',
      properties: {
        enabled: {
          title: 'Enabled',
          type: 'boolean',
          default: false
        },
        cpuWarning: {
          type: 'number',
          title: 'CPU Average % Warning Threshold',
          default: 80
        },
        cpuAlarm: {
          type: 'number',
          title: 'CPU Average % Alarm Threshold',
          default: 90
        },
        memWarning: {
          type: 'number',
          title: 'Memory Free % Warning Threshold',
          default: 20
        },
        memAlarm: {
          type: 'number',
          title: 'Memory Free % Alarm Threshold',
          default: 10
        },
        diskWarning: {
          type: 'number',
          title: 'Disk Free Space % Warning Threshold',
          default: 20
        },
        diskAlarm: {
          type: 'number',
          title: 'Disk Free Space % Alarm Threshold',
          default: 10
        },
        checkFrequency: {
          type: 'number',
          title: 'Check Frequency',
          description: 'How often to check the hosts (seconds).',
          default: 60
        },
        checkMaxAttempts: {
          type: 'number',
          title: 'Check Attempts',
          description: 'Number of failed checks before raising a notification.',
          default: 3
        },
        sendNotification: {
          type: 'boolean',
          title: 'Send Notification',
          default: false
        },
        sendEmail: {
          type: 'boolean',
          title: 'Send Email',
          default: false
        },
        toEmail: {
          type: 'string',
          title: 'Send Email To Address(es)',
          description: 'Comma separated list of recipients email addresses',
        }
      }
    };
    schema.properties["host"] = obj;

    updateProviderSchema(schema);

    var mailObj = {
      type: 'object',
      title: 'eMail Config',
      properties: {
        host: {
          type: 'string',
          title: 'Host',
        },
        port: {
          type: 'number',
          title: 'Port',
        },
        secure: {
          title: 'Secure',
          type: 'boolean',
          default: false
        },
        username: {
          type: 'string',
          title: 'Username',
        },
        password: {
          type: 'string',
          title: 'Password',
        },
        fromEmail: {
          type: 'string',
          title: 'From Address',
        }
      }
    };
    schema.properties["mail"] = mailObj;

    return schema;
  }

  plugin.start = function(options) {
    hcOptions = options;

    if (options.host.enabled) {
      app.debug("Host checks enabled.");
      hostCheck();

      hostTimer = setInterval(function() {
        hostCheck();
      }, options.host.checkFrequency * 1000)
    }

    let providers = options.providers;
    for (var providerId in providers) {
      if (providers[providerId].enabled) {
        app.debug(`Provider ${providerId} checks enabled.`);

        var provider = providers[providerId];
        provider.id = providerId;

        providersFailureCount[providerId] = 0;
        providersFailureEmailSent[providerId] = false;

        providerCheck(provider);

        providerTimers.push(setInterval(function() {
          providerCheck(provider);
        }, provider.checkFrequency * 1000))
      }
    }
  };

  //returns full details
  plugin.registerWithRouter = function(router) {
    router.get("/health", (req, res) => {
      let info = {};

      res.json(info);
    })

    //returns a simple "UP" or error message if there are issues
    router.get("/health/status", (req, res) => {
      res.json({
        "status": 'UP'
      });
    })

    //exposes the raw providerStatus
    router.get("/providerStatus", (req, res) => {
      let status = app.getProviderStatus();
      res.json(status);
    })

    //exposes the raw providerStatus for a provider
    router.get("/providerStatus/:provider", (req, res) => {
      let provider = req.params.provider;
      let status = app.getProviderStatus();

      let details = status.find(value => value.id === provider);

      if (details) {
        res.json(details);
      } else {
        let msg = 'No provider found for ' + provider
        app.debug(msg)
        res.status(400)
        res.send(msg)
        return
      }
    })

    //exposes the raw providerStatistics
    router.get("/providerStatistics", (req, res) => {
      let stats = app.providerStatistics;
      res.json(stats);
    })

    //exposes the raw providerStatistics for a provider
    router.get("/providerStatistics/:provider", (req, res) => {
      let provider = req.params.provider;
      let stats = app.providerStatistics;

      if (stats.hasOwnProperty(provider)) {
        res.json(stats[provider]);
      } else {
        let msg = 'No provider found for ' + provider
        app.debug(msg)
        res.status(400)
        res.send(msg)
        return
      }
    })

    router.get("/hostInfo", (req, res) => {
      if (osu.isNotSupported()) {
        let msg = 'OS is not supported by node-os-utils'
        app.debug(msg)
        res.status(400)
        res.send(msg)
        return
      }

      getHostInfo().then(info => {
        res.json(info)
      }, reason => {
        let msg = "Could not get host info. " + reason;
        app.debug(msg)
        app.status(400)
        res.send(msg)
        return
      });
    })

    router.get("/hostState", (req, res) => {
      res.json(hostCheck(hcOptions))
    })
  }

  function getHostInfo() {
    var cpu = osu.cpu
    var cpuInfo = cpu.usage().then(value => {
      return value
    });

    var mem = osu.mem
    var memInfo = mem.info().then(value => {
      return value
    });

    var drive = osu.drive
    var driveInfo = drive.info().then(value => {
      return value
    });

    return Promise.all([cpuInfo, memInfo, driveInfo]).then(values => ({
      "cpu": {
        "averageUsage": values[0]
      },
      "memory": values[1],
      "disk": values[2]
    }));
  }

  function sendEmail(to, subject, text) {
    var transporter = nodemailer.createTransport({
      "host": hcOptions.mail.host,
      "port": hcOptions.mail.port,
      "secure": hcOptions.mail.secure,
      "auth": {
        "user": hcOptions.mail.username,
        "pass": hcOptions.mail.password
      }
    });

    //use text or html
    var mailOptions = {
      "from": hcOptions.mail.fromEmail,
      "to": to,
      "subject": subject,
      "text": text
    };

    transporter.sendMail(mailOptions, function(error, info) {
      if (error) {
        app.error(error);
      } else {
        app.log('Email sent: ' + info.response);
      }
    });
  }

  function handleDelta(values) {
    let delta = {
      "updates": [{
        "values": values
      }]
    }
    app.debug(JSON.stringify(delta))

    app.handleMessage(PLUGIN_ID, delta)
  }

  function createHostDeltaValues(data) {
    let basePath = "host"
    let values = [];

    for (const tlkey in data) {
      let data2 = data[tlkey]
      let keys = Object.keys(data2)
      let values2 = (keys.map(key => ({
        "path": basePath + '.' + tlkey + '.' + key,
        "value": data2[key]
      })))
      values = values.concat(values2)
    }
    return values;
  }

  function createProviderDeltaValues(providerId, data) {
    let basePath = "provider"

    let keys = Object.keys(data);
    let values = (keys.map(key => ({
      "path": basePath + '.' + providerId + '.' + key,
      "value": data[key]
    })))

    return values;
  }

  function checkHostValues(data) {
    //check cpu
    let state = {};
    if (data.cpu.averageUsage >= hcOptions.host.cpuAlarm) {
      state["cpu"] = {
        "state": "alarm",
        "field": "averageCpu",
        "value": data.cpu.averageUsage
      }
    } else if (data.cpu.averageUsage >= hcOptions.host.cpuWarning) {
      state["cpu"] = {
        "state": "warn",
        "field": "averageCpu",
        "value": data.cpu.averageUsage
      }
    } else {
      state["cpu"] = {
        "state": "ok",
        "field": "averageCpu",
        "value": data.cpu.averageUsage
      }
    }
    //check Memory
    if (data.memory.freeMemPercentage <= hcOptions.host.memAlarm) {
      state["memory"] = {
        "state": "alarm",
        "field": "freeMemPercentage",
        "value": data.memory.freeMemPercentage
      }
    } else if (data.memory.freeMemPercentage <= hcOptions.host.memWarning) {
      state["memory"] = {
        "state": "warn",
        "field": "freeMemPercentage",
        "value": data.memory.freeMemPercentage
      }
    } else {
      state["memory"] = {
        "state": "ok",
        "field": "freeMemPercentage",
        "value": data.memory.freeMemPercentage
      }
    }
    //check disk
    if (data.disk.freePercentage <= hcOptions.host.diskAlarm) {
      state["disk"] = {
        "state": "alarm",
        "field": "freePercentage",
        "value": data.disk.freePercentage
      }
    } else if (data.disk.freePercentage <= hcOptions.host.diskWarning) {
      state["disk"] = {
        "state": "warn",
        "field": "freePercentage",
        "value": data.disk.freePercentage
      }
    } else {
      state["disk"] = {
        "state": "ok",
        "field": "freePercentage",
        "value": data.disk.freePercentage
      }
    }
    return state;
  }

  function createNotification(type, data) {
    let values = [];
    let value = {
      "state": "",
      "method": [
        "visual",
        "sound"
      ],
      "message": "",
    }

    for (var check in data) {
      let path = `notifications.${type}.${check}.${data[check].field}`;
      let existing = app.getSelfPath(path);

      if (data[check].state != "ok") {
        let checkC = check.charAt(0).toUpperCase() + check.slice(1);
        value.state = data[check].state;
        value.message = `${checkC} ${data[check].field} current value is ${data[check].value}. `;

        values.push({
          "path": path,
          "value": value
        });
      } else if (existing) {
        //the state must be ok so clear it
        values.push({
          "path": path,
          "value": null
        });
      }
    }
    return values;
  }

  function hostCheck() {
    getHostInfo().then(info => {
      //send deltas
      let values = createHostDeltaValues(info);
      handleDelta(values);

      //check for issues
      let hostState = checkHostValues(info)
      updateHostFailureCounters(hostState);

      //send Notification
      if (hcOptions.host.sendNotification) {
        let values = createNotification("host", hostState)
        if (values.length > 0) {
          handleDelta(values);
        }
      }

      //send email
      if (hcOptions.host.sendEmail) {
        sendHostEmail(hostState);
      }

    }, reason => {
      app.error("Could not get host info. " + reason);
    });
  }

  function providerCheck(provider) {
    let stats = app.providerStatistics;

    let pvStats = stats[provider.id];
    if (!pvStats) {
      app.error('Could not get statisics for ' + provider.id);
      return;
    }

    //send deltas
    let values = createProviderDeltaValues(provider.id, pvStats);
    handleDelta(values);

    let state = checkProviderStats(pvStats, provider)
    if (state.state != "ok") {
      providersFailureCount[provider.id]++;
      app.error(`Provider ${provider.id} #${providersFailureCount[provider.id]}`);

      if (provider.sendEmail && providersFailureCount[provider.id] >= provider.checkMaxAttempts &&
        !providersFailureEmailSent[provider.id]) {
        sendProviderEmail(provider, state);
        providersFailureEmailSent[provider.id] = true;
      }
    } else {
      //state is ok, so clear the failure count
      providersFailureCount[provider.id] = 0;
      providersFailureEmailSent[provider.id] = false;
    }
  }

  function checkProviderStats(pvStats, options) {
    let state = {
      "state": "ok",
      "value": pvStats.deltaRate
    };
    if (pvStats.deltaRate <= options.deltaAlarm) {
      state.state = "alarm";
    } else if (pvStats.delaRate <= options.deltaWarning) {
      state.state = "warn";
    }

    return state;
  }

  function sendHostEmail(state) {
    let subject = "SignalK Healthcheck Host ";
    let text = "";
    let hostState = 'Warning';

    for (var check in state) {
      if (state[check].state != "ok") {
        if(state[check].state == "alarm") hostState = 'Alarm';

        let checkC = check.charAt(0).toUpperCase() + check.slice(1);
        text += `${checkC} ${state[check].field} current value is ${state[check].value}. \r\n`;
      }
    }

    if (text && !hostFailureEmailSent) {
      subject += hostState;
      sendEmail(hcOptions.host.toEmail, subject, text);
      hostFailureEmailSent = true;
    } else if (!text) {
      hostFailureEmailSent = false;
    }
  }

  function sendProviderEmail(options, state) {
    let subject = `SignalK Healtcheck Provider ${state.state}`;
    let text = `Provider ${options.id} is only processing ${state.value} deltas.`;
    sendEmail(options.toEmail, subject, text);
  }

  function updateHostFailureCounters(state) {
    for (var check in state) {
      if (state[check].state != "ok") {
        hostFailureCount[check]++;
      } else {
        hostFailureCount[check] = 0;
      }
    }
  }

  plugin.stop = function() {
    if (hostTimer) {
      clearInterval(hostTimer)
    }

    if (providerTimers.length > 0) {
      providerTimers.forEach(timer => clearInterval(timer))
      providerTimers = [];
    }
  };

  return plugin;
};
