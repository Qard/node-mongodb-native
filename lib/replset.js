var EventEmitter = require('events').EventEmitter
  , inherits = require('util').inherits
  , f = require('util').format
  , Server = require('./server')
  , Mongos = require('./mongos')
  , Cursor = require('./cursor')
  , ReadPreference = require('./read_preference')
  , MongoCR = require('mongodb-core').MongoCR
  , MongoError = require('mongodb-core').MongoError
  , ServerCapabilities = require('./topology_base').ServerCapabilities
  , Store = require('./topology_base').Store
  , CServer = require('mongodb-core').Server
  , CReplSet = require('mongodb-core').ReplSet
  , CoreReadPreference = require('mongodb-core').ReadPreference
  , shallowClone = require('./utils').shallowClone;

/**
 * @fileOverview The **ReplSet** class is a class that represents a Replicaset topology and is
 * used to construct connections.
 * 
 * **ReplSet Should not be used, use MongoClient.connect**
 * @example
 * var Db = require('mongodb').Db,
 *   ReplSet = require('mongodb').ReplSet,
 *   Server = require('mongodb').Server,
 *   test = require('assert');
 * // Connect using ReplSet
 * var server = new Server('localhost', 27017);
 * var db = new Db('test', new ReplSet([server]));
 * db.open(function(err, db) {
 *   // Get an additional db
 *   db.close();
 * });
 */

/**
 * Creates a new ReplSet instance
 * @class
 * @deprecated
 * @param {Server[]} servers A seedlist of servers participating in the replicaset.
 * @param {object} [options=null] Optional settings.
 * @param {booelan} [options.ha=true] Turn on high availability monitoring.
 * @param {number} [options.haInterval=5000] Time between each replicaset status check.
 * @param {string} options.replicaSet The name of the replicaset to connect to.
 * @param {number} [options.secondaryAcceptableLatencyMS=15] Sets the range of servers to pick when using NEAREST (lowest ping ms + the latency fence, ex: range of 1 to (1 + 15) ms) 
 * @param {boolean} [options.connectWithNoPrimary=false] Sets if the driver should connect even if no primary is available
 * @param {number} [options.poolSize=5] Number of connections in the connection pool for each server instance, set to 5 as default for legacy reasons.
 * @param {boolean} [options.ssl=false] Use ssl connection (needs to have a mongod server with ssl support) 
 * @param {object} [options.sslValidate=false] Validate mongod server certificate against ca (needs to have a mongod server with ssl support, 2.4 or higher)
 * @param {array} [options.sslCA=null] Array of valid certificates either as Buffers or Strings (needs to have a mongod server with ssl support, 2.4 or higher)
 * @param {(Buffer|string)} [options.sslCert=null] String or buffer containing the certificate we wish to present (needs to have a mongod server with ssl support, 2.4 or higher)
 * @param {(Buffer|string)} [options.sslKey=null] String or buffer containing the certificate private key we wish to present (needs to have a mongod server with ssl support, 2.4 or higher)
 * @param {(Buffer|string)} [options.sslPass=null] String or buffer containing the certificate password (needs to have a mongod server with ssl support, 2.4 or higher)
 * @param {object} [options.socketOptions=null] Socket options 
 * @param {boolean} [options.socketOptions.noDelay=true] TCP Socket NoDelay option. 
 * @param {number} [options.socketOptions.keepAlive=0] TCP KeepAlive on the socket with a X ms delay before start. 
 * @param {number} [options.socketOptions.connectTimeoutMS=0] TCP Connection timeout setting 
 * @param {number} [options.socketOptions.socketTimeoutMS=0] TCP Socket timeout setting 
 * @fires ReplSet#connect
 * @fires ReplSet#ha
 * @fires ReplSet#joined
 * @fires ReplSet#left
 * @fires ReplSet#fullsetup
 * @fires ReplSet#open
 * @fires ReplSet#close
 * @fires ReplSet#error
 * @fires ReplSet#timeout
 * @fires ReplSet#parseError
 * @return {ReplSet} a ReplSet instance.
 */
var ReplSet = function(servers, options) {  
  if(!(this instanceof ReplSet)) return new ReplSet(servers, options);
  options = options || {};
  var self = this;

  // Ensure all the instances are Server
  for(var i = 0; i < servers.length; i++) {
    if(!(servers[i] instanceof Server)) {
      throw new MongoError("all seed list instances must be of the Server type");
    }
  }

  // Store option defaults
  var storeOptions = {
      force: false
    , bufferMaxEntries: -1
  }

  // Shared global store
  var store = options.store || new Store(self, storeOptions);

  // Set up event emitter
  EventEmitter.call(this);

  // Debug tag
  var tag = options.tag;

  // Build seed list
  var seedlist = servers.map(function(x) {
    return {host: x.host, port: x.port}
  });

  // Final options
  var finalOptions = shallowClone(options);

  // Default values  
  finalOptions.size = typeof options.poolSize == 'number' ? options.poolSize : 5;
  finalOptions.reconnect = typeof options.auto_reconnect == 'boolean' ? options.auto_reconnect : true;
  finalOptions.emitError = typeof options.emitError == 'boolean' ? options.emitError : true;
  finalOptions.cursorFactory = Cursor;

  // Add the store
  finalOptions.disconnectHandler = store;

  // Socket options passed down
  if(options.socketOptions) {
    if(options.socketOptions.connectTimeoutMS)
      finalOptions.connectionTimeout = options.socketOptions.connectTimeoutMS;
    if(options.socketOptions.socketTimeoutMS)
      finalOptions.socketTimeout = options.socketOptions.socketTimeoutMS;
  } 

  // Get the name
  var replicaSet = options.replicaSet || options.rs_name;

  // If no rs_name throw
  if(replicaSet == null) 
    throw new MongoError('replicaSet parameter must be set');

  // Set up options
  finalOptions.setName = replicaSet;

  // Are we running in debug mode
  var debug = typeof options.debug == 'boolean' ? options.debug : false;
  if(debug) {
    finalOptions.debug = debug;
  }

  // Map keep alive setting
  if(options.socketOptions && typeof options.socketOptions.keepAlive == 'number') {
    finalOptions.keepAlive = true;
    if(typeof options.socketOptions.keepAlive == 'number') {
      finalOptions.keepAliveInitialDelay = options.socketOptions.keepAlive;
    }
  }

  // Connection timeout
  if(options.socketOptions && typeof options.socketOptions.connectionTimeout == 'number') {
    finalOptions.connectionTimeout = options.socketOptions.connectionTimeout;
  }

  // Socket timeout
  if(options.socketOptions && typeof options.socketOptions.socketTimeout == 'number') {
    finalOptions.socketTimeout = options.socketOptions.socketTimeout;
  }

  // noDelay
  if(options.socketOptions && typeof options.socketOptions.noDelay == 'boolean') {
    finalOptions.noDelay = options.socketOptions.noDelay;
  }

  if(typeof options.secondaryAcceptableLatencyMS == 'number') {
    finalOptions.acceptableLatency = options.secondaryAcceptableLatencyMS;
  }

  if(options.connectWithNoPrimary == true) {
    finalOptions.secondaryOnlyConnectionAllowed = true;
  }

  // Add the non connection store
  finalOptions.disconnectHandler = store;

  // Translate the options
  if(options.sslCA) finalOptions.ca = options.sslCA;
  if(typeof options.sslValidate == 'boolean') finalOptions.rejectUnauthorized = options.sslValidate;
  if(options.sslKey) finalOptions.key = options.sslKey;
  if(options.sslCert) finalOptions.cert = options.sslCert;
  if(options.sslPass) finalOptions.passphrase = options.sslPass;

  // Create the ReplSet
  var replset = new CReplSet(seedlist, finalOptions)
  // Server capabilities
  var sCapabilities = null;
  // Add auth prbufferMaxEntriesoviders
  replset.addAuthProvider('mongocr', new MongoCR());

  // Listen to reconnect event
  replset.on('reconnect', function() {
    self.emit('reconnect');
    store.execute();
  });

  // Internal state
  this.s = {
    // Replicaset
    replset: replset
    // Server capabilities
    , sCapabilities: null
    // Debug tag
    , tag: options.tag
    // Store options
    , storeOptions: storeOptions
    // Store
    , store: store
    // Options
    , options: options
  }
  
  // Debug
  if(debug) {
    // Last ismaster
    Object.defineProperty(this, 'replset', {
      enumerable:true, get: function() { return replset; }
    });    
  }

  // Last ismaster
  Object.defineProperty(this, 'isMasterDoc', {
    enumerable:true, get: function() { return replset.lastIsMaster(); }
  });

  // BSON property
  Object.defineProperty(this, 'bson', { 
    enumerable: true, get: function() { 
      return replset.bson; 
    }
  });

  Object.defineProperty(this, 'haInterval', {
    enumerable:true, get: function() { return replset.haInterval; }
  });
}

/**
 * @ignore
 */
inherits(ReplSet, EventEmitter);

// Ensure the right read Preference object
var translateReadPreference = function(options) {
  if(typeof options.readPreference == 'string') {
    options.readPreference = new CoreReadPreference(options.readPreference);
  } else if(options.readPreference instanceof ReadPreference) {
    options.readPreference = new CoreReadPreference(options.readPreference.mode
      , options.readPreference.tags);
  }

  return options;  
}

ReplSet.prototype.parserType = function() {
  return this.s.replset.parserType();
}

// Connect method
ReplSet.prototype.connect = function(db, _options, callback) {
  var self = this;
  if('function' === typeof _options) callback = _options, _options = {};
  if(_options == null) _options = {};
  if(!('function' === typeof callback)) callback = null;
  self.s.options = _options;

  // Update bufferMaxEntries
  self.s.storeOptions.bufferMaxEntries = db.bufferMaxEntries;

  // Actual handler
  var errorHandler = function(event) {
    return function(err) {
      if(event != 'error') {
        self.emit(event, err);
      }
    }
  }

  // Connect handler
  var connectHandler = function() {
    // Clear out all the current handlers left over
    ["timeout", "error", "close"].forEach(function(e) {
      self.s.replset.removeAllListeners(e);
    });

    // Set up listeners
    self.s.replset.once('timeout', errorHandler('timeout'));
    self.s.replset.once('error', errorHandler('error'));
    self.s.replset.once('close', errorHandler('close'));

    // relay the event
    var relay = function(event) {
      return function(t, server) {
        self.emit(event, t, server);
      }
    }

    // Replset events relay
    var replsetRelay = function(event) {
      return function(t, server) {
        self.emit(event, t, server.lastIsMaster(), server);
      }
    }

    // Relay ha
    var relayHa = function(t, state) {
      self.emit('ha', t, state);          

      if(t == 'start') {
        self.emit('ha_connect', t, state);          
      } else if(t == 'end') {
        self.emit('ha_ismaster', t, state);          
      }
    }

    // Set up serverConfig listeners
    self.s.replset.on('joined', replsetRelay('joined'));
    self.s.replset.on('left', relay('left'));
    self.s.replset.on('ping', relay('ping'));
    self.s.replset.on('ha', relayHa);
    
    self.s.replset.on('fullsetup', function(topology) {
      self.emit('fullsetup', null, self);
    });
    
    self.s.replset.on('all', function(topology) {
      self.emit('all', null, self);
    });

    // Emit open event
    self.emit('open', null, self);      

    // Return correctly
    try {
      callback(null, self);
    } catch(err) { 
      process.nextTick(function() { throw err; })
    }      
  }

  // Error handler
  var connectErrorHandler = function(event) {
    return function(err) {
      ['timeout', 'error', 'close'].forEach(function(e) {
        self.s.replset.removeListener(e, connectErrorHandler);
      });

      self.s.replset.removeListener('connect', connectErrorHandler);
      // Destroy the replset
      self.s.replset.destroy();

      // Try to callback
      try {
        callback(err);
      } catch(err) { 
        if(!self.s.replset.isConnected())
          process.nextTick(function() { throw err; })
      }
    }
  }    

  // Set up listeners
  self.s.replset.once('timeout', connectErrorHandler('timeout'));
  self.s.replset.once('error', connectErrorHandler('error'));
  self.s.replset.once('close', connectErrorHandler('close'));
  self.s.replset.once('connect', connectHandler);

  // Start connection
  self.s.replset.connect(_options);
}  

// Server capabilities
ReplSet.prototype.capabilities = function() {
  if(this.s.sCapabilities) return this.s.sCapabilities;
  this.s.sCapabilities = new ServerCapabilities(this.s.replset.lastIsMaster());
  return this.s.sCapabilities;
}

// Command
ReplSet.prototype.command = function(ns, cmd, options, callback) {
  options = translateReadPreference(options);
  this.s.replset.command(ns, cmd, options, callback);
}

// Insert
ReplSet.prototype.insert = function(ns, ops, options, callback) {
  this.s.replset.insert(ns, ops, options, callback);
}

// Update
ReplSet.prototype.update = function(ns, ops, options, callback) {
  this.s.replset.update(ns, ops, options, callback);
}

// Remove
ReplSet.prototype.remove = function(ns, ops, options, callback) {
  this.s.replset.remove(ns, ops, options, callback);
}

// IsConnected
ReplSet.prototype.isConnected = function() {
  return this.s.replset.isConnected();
}

ReplSet.prototype.setBSONParserType = function(type) {
  return this.s.replset.setBSONParserType(type);
}  

// Insert
ReplSet.prototype.cursor = function(ns, cmd, options) {
  options = translateReadPreference(options);
  options.disconnectHandler = this.s.store;
  return this.s.replset.cursor(ns, cmd, options);
}

ReplSet.prototype.lastIsMaster = function() {
  return this.s.replset.lastIsMaster();
}

ReplSet.prototype.close = function(forceClosed) {
  var self = this;
  this.s.replset.destroy();
  // We need to wash out all stored processes
  if(forceClosed == true) {
    this.s.storeOptions.force = forceClosed;
    this.s.store.flush();
  }

  var events = ['timeout', 'error', 'close', 'joined', 'left'];
  events.forEach(function(e) {
    self.removeAllListeners(e);
  });        
}

ReplSet.prototype.auth = function() {
  var args = Array.prototype.slice.call(arguments, 0);
  this.s.replset.auth.apply(this.s.replset, args);
}

/**
 * All raw connections
 * @method
 * @return {array}
 */
ReplSet.prototype.connections = function() {
  return this.s.replset.connections();
}    

/**
 * A replset connect event, used to verify that the connection is up and running
 *
 * @event ReplSet#connect
 * @type {ReplSet}
 */

/**
 * The replset high availability event
 *
 * @event ReplSet#ha
 * @type {function}
 * @param {string} type The stage in the high availability event (start|end)
 * @param {boolean} data.norepeat This is a repeating high availability process or a single execution only
 * @param {number} data.id The id for this high availability request
 * @param {object} data.state An object containing the information about the current replicaset
 */

/**
 * A server member left the replicaset
 *
 * @event ReplSet#left
 * @type {function}
 * @param {string} type The type of member that left (primary|secondary|arbiter)
 * @param {Server} server The server object that left
 */

/**
 * A server member joined the replicaset
 *
 * @event ReplSet#joined
 * @type {function}
 * @param {string} type The type of member that joined (primary|secondary|arbiter)
 * @param {Server} server The server object that joined
 */

/**
 * ReplSet open event, emitted when replicaset can start processing commands.
 *
 * @event ReplSet#open
 * @type {Replset}
 */

/**
 * ReplSet fullsetup event, emitted when all servers in the topology have been connected to.
 *
 * @event ReplSet#fullsetup
 * @type {Replset}
 */

/**
 * ReplSet close event
 *
 * @event ReplSet#close
 * @type {object}
 */

/**
 * ReplSet error event, emitted if there is an error listener.
 *
 * @event ReplSet#error
 * @type {MongoError}
 */

/**
 * ReplSet timeout event
 *
 * @event ReplSet#timeout
 * @type {object}
 */

/**
 * ReplSet parseError event
 *
 * @event ReplSet#parseError
 * @type {object}
 */

module.exports = ReplSet;
// var EventEmitter = require('events').EventEmitter
//   , inherits = require('util').inherits
//   , f = require('util').format
//   , Server = require('./server')
//   , Mongos = require('./mongos')
//   , Cursor = require('./cursor')
//   , ReadPreference = require('./read_preference')
//   , MongoCR = require('mongodb-core').MongoCR
//   , MongoError = require('mongodb-core').MongoError
//   , ServerCapabilities = require('./topology_base').ServerCapabilities
//   , Store = require('./topology_base').Store
//   , CServer = require('mongodb-core').Server
//   , CReplSet = require('mongodb-core').ReplSet
//   , CoreReadPreference = require('mongodb-core').ReadPreference
//   , shallowClone = require('./utils').shallowClone;

// /**
//  * @fileOverview The **ReplSet** class is a class that represents a Replicaset topology and is
//  * used to construct connections.
//  * 
//  * **ReplSet Should not be used, use MongoClient.connect**
//  * @example
//  * var Db = require('mongodb').Db,
//  *   ReplSet = require('mongodb').ReplSet,
//  *   Server = require('mongodb').Server,
//  *   test = require('assert');
//  * // Connect using ReplSet
//  * var server = new Server('localhost', 27017);
//  * var db = new Db('test', new ReplSet([server]));
//  * db.open(function(err, db) {
//  *   // Get an additional db
//  *   db.close();
//  * });
//  */

// /**
//  * Creates a new ReplSet instance
//  * @class
//  * @deprecated
//  * @param {Server[]} servers A seedlist of servers participating in the replicaset.
//  * @param {object} [options=null] Optional settings.
//  * @param {booelan} [options.ha=true] Turn on high availability monitoring.
//  * @param {number} [options.haInterval=5000] Time between each replicaset status check.
//  * @param {string} options.replicaSet The name of the replicaset to connect to.
//  * @param {number} [options.secondaryAcceptableLatencyMS=15] Sets the range of servers to pick when using NEAREST (lowest ping ms + the latency fence, ex: range of 1 to (1 + 15) ms) 
//  * @param {boolean} [options.connectWithNoPrimary=false] Sets if the driver should connect even if no primary is available
//  * @param {number} [options.poolSize=5] Number of connections in the connection pool for each server instance, set to 5 as default for legacy reasons.
//  * @param {boolean} [options.ssl=false] Use ssl connection (needs to have a mongod server with ssl support) 
//  * @param {object} [options.sslValidate=false] Validate mongod server certificate against ca (needs to have a mongod server with ssl support, 2.4 or higher)
//  * @param {array} [options.sslCA=null] Array of valid certificates either as Buffers or Strings (needs to have a mongod server with ssl support, 2.4 or higher)
//  * @param {(Buffer|string)} [options.sslCert=null] String or buffer containing the certificate we wish to present (needs to have a mongod server with ssl support, 2.4 or higher)
//  * @param {(Buffer|string)} [options.sslKey=null] String or buffer containing the certificate private key we wish to present (needs to have a mongod server with ssl support, 2.4 or higher)
//  * @param {(Buffer|string)} [options.sslPass=null] String or buffer containing the certificate password (needs to have a mongod server with ssl support, 2.4 or higher)
//  * @param {object} [options.socketOptions=null] Socket options 
//  * @param {boolean} [options.socketOptions.noDelay=true] TCP Socket NoDelay option. 
//  * @param {number} [options.socketOptions.keepAlive=0] TCP KeepAlive on the socket with a X ms delay before start. 
//  * @param {number} [options.socketOptions.connectTimeoutMS=0] TCP Connection timeout setting 
//  * @param {number} [options.socketOptions.socketTimeoutMS=0] TCP Socket timeout setting 
//  * @fires ReplSet#connect
//  * @fires ReplSet#ha
//  * @fires ReplSet#joined
//  * @fires ReplSet#left
//  * @fires ReplSet#fullsetup
//  * @fires ReplSet#open
//  * @fires ReplSet#close
//  * @fires ReplSet#error
//  * @fires ReplSet#timeout
//  * @fires ReplSet#parseError
//  * @return {ReplSet} a ReplSet instance.
//  */
// var ReplSet = function(servers, options) {  
//   if(!(this instanceof ReplSet)) return new ReplSet(servers, options);
//   options = options || {};
//   var self = this;

//   // Ensure all the instances are Server
//   for(var i = 0; i < servers.length; i++) {
//     if(!(servers[i] instanceof Server)) {
//       throw new MongoError("all seed list instances must be of the Server type");
//     }
//   }

//   // Store option defaults
//   var storeOptions = {
//       force: false
//     , bufferMaxEntries: -1
//   }

//   // Shared global store
//   var store = options.store || new Store(self, storeOptions);

//   // Set up event emitter
//   EventEmitter.call(this);

//   // Debug tag
//   var tag = options.tag;

//   // Build seed list
//   var seedlist = servers.map(function(x) {
//     return {host: x.host, port: x.port}
//   });

//   // Final options
//   var finalOptions = shallowClone(options);

//   // Default values  
//   finalOptions.size = typeof options.poolSize == 'number' ? options.poolSize : 5;
//   finalOptions.reconnect = typeof options.auto_reconnect == 'boolean' ? options.auto_reconnect : true;
//   finalOptions.emitError = typeof options.emitError == 'boolean' ? options.emitError : true;
//   finalOptions.cursorFactory = Cursor;

//   // Add the store
//   finalOptions.disconnectHandler = store;

//   // Socket options passed down
//   if(options.socketOptions) {
//     if(options.socketOptions.connectTimeoutMS)
//       finalOptions.connectionTimeout = options.socketOptions.connectTimeoutMS;
//     if(options.socketOptions.socketTimeoutMS)
//       finalOptions.socketTimeout = options.socketOptions.socketTimeoutMS;
//   } 

//   // Get the name
//   var replicaSet = options.replicaSet || options.rs_name;

//   // If no rs_name throw
//   if(replicaSet == null) 
//     throw new MongoError('replicaSet parameter must be set');

//   // Set up options
//   finalOptions.setName = replicaSet;

//   // Are we running in debug mode
//   var debug = typeof options.debug == 'boolean' ? options.debug : false;
//   if(debug) {
//     finalOptions.debug = debug;
//   }

//   // Map keep alive setting
//   if(options.socketOptions && typeof options.socketOptions.keepAlive == 'number') {
//     finalOptions.keepAlive = true;
//     if(typeof options.socketOptions.keepAlive == 'number') {
//       finalOptions.keepAliveInitialDelay = options.socketOptions.keepAlive;
//     }
//   }

//   // Connection timeout
//   if(options.socketOptions && typeof options.socketOptions.connectionTimeout == 'number') {
//     finalOptions.connectionTimeout = options.socketOptions.connectionTimeout;
//   }

//   // Socket timeout
//   if(options.socketOptions && typeof options.socketOptions.socketTimeout == 'number') {
//     finalOptions.socketTimeout = options.socketOptions.socketTimeout;
//   }

//   // noDelay
//   if(options.socketOptions && typeof options.socketOptions.noDelay == 'boolean') {
//     finalOptions.noDelay = options.socketOptions.noDelay;
//   }

//   if(typeof options.secondaryAcceptableLatencyMS == 'number') {
//     finalOptions.acceptableLatency = options.secondaryAcceptableLatencyMS;
//   }

//   if(options.connectWithNoPrimary == true) {
//     finalOptions.secondaryOnlyConnectionAllowed = true;
//   }

//   // Add the non connection store
//   finalOptions.disconnectHandler = store;

//   // Translate the options
//   if(options.sslCA) finalOptions.ca = options.sslCA;
//   if(typeof options.sslValidate == 'boolean') finalOptions.rejectUnauthorized = options.sslValidate;
//   if(options.sslKey) finalOptions.key = options.sslKey;
//   if(options.sslCert) finalOptions.cert = options.sslCert;
//   if(options.sslPass) finalOptions.passphrase = options.sslPass;

//   // Create the ReplSet
//   var replset = new CReplSet(seedlist, finalOptions)
//   // Server capabilities
//   var sCapabilities = null;
//   // Add auth prbufferMaxEntriesoviders
//   replset.addAuthProvider('mongocr', new MongoCR());

//   // Listen to reconnect event
//   replset.on('reconnect', function() {
//     self.emit('reconnect');
//     store.execute();
//   });
  
//   // Ensure the right read Preference object
//   var translateReadPreference = function(options) {
//     if(typeof options.readPreference == 'string') {
//       options.readPreference = new CoreReadPreference(options.readPreference);
//     } else if(options.readPreference instanceof ReadPreference) {
//       options.readPreference = new CoreReadPreference(options.readPreference.mode
//         , options.readPreference.tags);
//     }

//     return options;  
//   }

//   // Debug
//   if(debug) {
//     // Last ismaster
//     Object.defineProperty(this, 'replset', {
//       enumerable:true, get: function() { return replset; }
//     });    
//   }

//   // Last ismaster
//   Object.defineProperty(this, 'isMasterDoc', {
//     enumerable:true, get: function() { return replset.lastIsMaster(); }
//   });

//   // BSON property
//   Object.defineProperty(this, 'bson', { 
//     enumerable: true, get: function() { 
//       return replset.bson; 
//     }
//   });

//   Object.defineProperty(this, 'haInterval', {
//     enumerable:true, get: function() { return replset.haInterval; }
//   });

//   this.parserType = function() {
//     return replset.parserType();
//   }

//   // Connect method
//   this.connect = function(db, _options, callback) {
//     var self = this;
//     if('function' === typeof _options) callback = _options, _options = {};
//     if(_options == null) _options = {};
//     if(!('function' === typeof callback)) callback = null;
//     options = _options;

//     // Update bufferMaxEntries
//     storeOptions.bufferMaxEntries = db.bufferMaxEntries;

//     // Actual handler
//     var errorHandler = function(event) {
//       return function(err) {
//         if(event != 'error') {
//           self.emit(event, err);
//         }
//       }
//     }

//     // Connect handler
//     var connectHandler = function() {
//       // Clear out all the current handlers left over
//       ["timeout", "error", "close"].forEach(function(e) {
//         replset.removeAllListeners(e);
//       });

//       // Set up listeners
//       replset.once('timeout',  errorHandler('timeout'));
//       replset.once('error',  errorHandler('error'));
//       replset.once('close', errorHandler('close'));

//       // relay the event
//       var relay = function(event) {
//         return function(t, server) {
//           self.emit(event, t, server);
//         }
//       }

//       // Replset events relay
//       var replsetRelay = function(event) {
//         return function(t, server) {
//           self.emit(event, t, server.lastIsMaster(), server);
//         }
//       }

//       // Relay ha
//       var relayHa = function(t, state) {
//         self.emit('ha', t, state);          

//         if(t == 'start') {
//           self.emit('ha_connect', t, state);          
//         } else if(t == 'end') {
//           self.emit('ha_ismaster', t, state);          
//         }
//       }

//       // Set up serverConfig listeners
//       replset.on('joined', replsetRelay('joined'));
//       replset.on('left', relay('left'));
//       replset.on('ping', relay('ping'));
//       replset.on('ha', relayHa);
//       replset.on('fullsetup', function(topology) {
//         self.emit('fullsetup', null, self);
//       });

//       // Emit open event
//       self.emit('open', null, self);      

//       // Return correctly
//       try {
//         callback(null, self);
//       } catch(err) { 
//         process.nextTick(function() { throw err; })
//       }      
//     }

//     // Error handler
//     var connectErrorHandler = function(event) {
//       return function(err) {
//         ['timeout', 'error', 'close'].forEach(function(e) {
//           replset.removeListener(e, connectErrorHandler);
//         });

//         replset.removeListener('connect', connectErrorHandler);
//         // Destroy the replset
//         replset.destroy();

//         // Try to callback
//         try {
//           callback(err);
//         } catch(err) { 
//           if(!replset.isConnected())
//             process.nextTick(function() { throw err; })
//         }
//       }
//     }    

//     // Set up listeners
//     replset.once('timeout',  connectErrorHandler('timeout'));
//     replset.once('error',  connectErrorHandler('error'));
//     replset.once('close', connectErrorHandler('close'));
//     replset.once('connect', connectHandler);

//     // Start connection
//     replset.connect(_options);
//   }  

//   // Server capabilities
//   this.capabilities = function() {
//     if(sCapabilities) return sCapabilities;
//     sCapabilities = new ServerCapabilities(replset.lastIsMaster());
//     return sCapabilities;
//   }

//   // Command
//   this.command = function(ns, cmd, options, callback) {
//     options = translateReadPreference(options);
//     replset.command(ns, cmd, options, callback);
//   }

//   // Insert
//   this.insert = function(ns, ops, options, callback) {
//     replset.insert(ns, ops, options, callback);
//   }

//   // Update
//   this.update = function(ns, ops, options, callback) {
//     replset.update(ns, ops, options, callback);
//   }

//   // Remove
//   this.remove = function(ns, ops, options, callback) {
//     replset.remove(ns, ops, options, callback);
//   }

//   // IsConnected
//   this.isConnected = function() {
//     return replset.isConnected();
//   }

//   this.setBSONParserType = function(type) {
//     return replset.setBSONParserType(type);
//   }  

//   // Insert
//   this.cursor = function(ns, cmd, options) {
//     options = translateReadPreference(options);
//     options.disconnectHandler = store;
//     return replset.cursor(ns, cmd, options);
//   }

//   this.lastIsMaster = function() {
//     return replset.lastIsMaster();
//   }

//   this.close = function(forceClosed) {
//     replset.destroy();
//     // We need to wash out all stored processes
//     if(forceClosed == true) {
//       storeOptions.force = forceClosed;
//       store.flush();
//     }

//     var events = ['timeout', 'error', 'close', 'joined', 'left'];
//     events.forEach(function(e) {
//       self.removeAllListeners(e);
//     });        
//   }

//   this.auth = function() {
//     var args = Array.prototype.slice.call(arguments, 0);
//     replset.auth.apply(replset, args);
//   }

//   /**
//    * All raw connections
//    * @method
//    * @return {array}
//    */
//   this.connections = function() {
//     return replset.connections();
//   }    
// }

// /**
//  * A replset connect event, used to verify that the connection is up and running
//  *
//  * @event ReplSet#connect
//  * @type {ReplSet}
//  */

// /**
//  * The replset high availability event
//  *
//  * @event ReplSet#ha
//  * @type {function}
//  * @param {string} type The stage in the high availability event (start|end)
//  * @param {boolean} data.norepeat This is a repeating high availability process or a single execution only
//  * @param {number} data.id The id for this high availability request
//  * @param {object} data.state An object containing the information about the current replicaset
//  */

// /**
//  * A server member left the replicaset
//  *
//  * @event ReplSet#left
//  * @type {function}
//  * @param {string} type The type of member that left (primary|secondary|arbiter)
//  * @param {Server} server The server object that left
//  */

// /**
//  * A server member joined the replicaset
//  *
//  * @event ReplSet#joined
//  * @type {function}
//  * @param {string} type The type of member that joined (primary|secondary|arbiter)
//  * @param {Server} server The server object that joined
//  */

// /**
//  * ReplSet open event, emitted when replicaset can start processing commands.
//  *
//  * @event ReplSet#open
//  * @type {Replset}
//  */

// /**
//  * ReplSet fullsetup event, emitted when all servers in the topology have been connected to.
//  *
//  * @event ReplSet#fullsetup
//  * @type {Replset}
//  */

// /**
//  * ReplSet close event
//  *
//  * @event ReplSet#close
//  * @type {object}
//  */

// /**
//  * ReplSet error event, emitted if there is an error listener.
//  *
//  * @event ReplSet#error
//  * @type {MongoError}
//  */

// /**
//  * ReplSet timeout event
//  *
//  * @event ReplSet#timeout
//  * @type {object}
//  */

// /**
//  * ReplSet parseError event
//  *
//  * @event ReplSet#parseError
//  * @type {object}
//  */

// /**
//  * @ignore
//  */
// inherits(ReplSet, EventEmitter);

// module.exports = ReplSet;