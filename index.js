const osu = require('node-os-utils')

const PLUGIN_ID = 'signalk-healthcheck'
const PLUGIN_NAME = 'Healthcheck Service'

module.exports = function(app) {
  var plugin = {};

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
            title: 'Check Attemps',
            description: 'Number of failed checks before raising a notification.',
            default: 3
          }
        }
      }
      providerSchema.properties[provider.id] = obj;
    })

    schema.properties["provider"] = providerSchema;
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
          description: '',
          default: 80
        },
        cpuAlarm: {
          type: 'number',
          title: 'CPU Average % Alarm Threshold',
          description: '',
          default: 90
        },
        memWarning: {
          type: 'number',
          title: 'Memory Free % Warning Threshold',
          description: '',
          default: 20
        },
        memAlarm: {
          type: 'number',
          title: 'Memory Free % Alarm Threshold',
          description: '',
          default: 10
        },
        diskWarning: {
          type: 'number',
          title: 'Disk Free Space % Warning Threshold',
          description: '',
          default: 20
        },
        diskAlarm: {
          type: 'number',
          title: 'Disk Free Space % Alarm Threshold',
          description: '',
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
          title: 'Check Attemps',
          description: 'Number of failed checks before raising a notification.',
          default: 3
        }
      }
    };
    schema.properties["host"] = obj;

    updateProviderSchema(schema)
    return schema;
  }

  plugin.start = function(options) {
    // Here we put our plugin logic
    app.debug('Plugin started');
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

    router.get("/host", (req, res) => {
      if (osu.isNotSupported()) {
        let msg = 'OS is not supported by node-os-utils'
        app.debug(msg)
        res.status(400)
        res.send(msg)
        return
      }

      getHostInfo().then(info => {
        res.json(info)
      });
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
    var driveInfo = drive.info(value => {
      return value
    });

    return Promise.all([cpuInfo, memInfo, driveInfo]).then(values => ({
      "cpu": {
        "averageUsage": values[0]
      },
      "mem": values[1],
      "disk": values[2]
    }));
  }

  plugin.stop = function() {
    // Here we put logic we need when the plugin stops
    app.debug('Plugin stopped');
  };

  return plugin;
};
