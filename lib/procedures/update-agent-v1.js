/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */


var p = console.log;
var assert = require('assert-plus');
var sprintf = require('extsprintf').sprintf;
var util = require('util'),
    format = util.format;
var child_process = require('child_process'),
    execFile = child_process.execFile,
    spawn = child_process.spawn;
var fs = require('fs');
var path = require('path');
var vasync = require('vasync');
var semver = require('semver');

var errors = require('../errors'),
    InternalError = errors.InternalError,
    SDCClientError = errors.SDCClientError,
    UpdateError = errors.UpdateError,
    MultiError = errors.MultiError;

var common = require('../common');
var vmadm = require('../vmadm');
var svcadm = require('../svcadm');

var Procedure = require('./procedure').Procedure;
var s = require('./shared');

/**
 * Procedure for updating the different agent services.
 */
function UpdateAgentV1(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(UpdateAgentV1, Procedure);


UpdateAgentV1.prototype.summarize = function uaSummarize() {
    var c0 = this.changes[0];
    var img = c0.image;
    var out = [sprintf('update "%s" service to image %s (%s@%s)',
                    c0.service.name, img.uuid, img.name, img.version)];
    return out.join('\n');
};

// The minimal required CNAPI version (CNAPI-508, CNAPI-511):
UpdateAgentV1.MIN_CNAPI_VERSION = '20150407T172714Z';
// The first cn-agent version able to run install_agent task:
UpdateAgentV1.MIN_CN_AGENT_VERSION = '2015-04-07T11:26:47Z';

// How many CNs we want to attempt to update in parallel:
UpdateAgentV1.CN_CONCUR = 10;

UpdateAgentV1.prototype.execute = function uaExecute(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.plan, 'opts.plan');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.progress, 'opts.progress');
    assert.string(opts.wrkDir, 'opts.wrkDir');
    assert.func(callback, 'callback');
    var self = this;
    var progress = opts.progress;
    var sdcadm = opts.sdcadm;
    var log = opts.log;
    // Given we may have errors for some CNs, and not from some others, we
    // need to store errors and report at end:
    var errs = [];

    function updateAgent(change, nextSvc) {
        log.debug({change: change}, 'updateAgent');

        var cnAgentInsts = [];

        vasync.pipeline({funcs: [
            function checkMinCNAPIVersion(_, next) {
                progress('Verifying that CNAPI is able to run agent updates');
                sdcadm.listInsts({
                    svcs: ['cnapi', 'cn-agent']
                }, function (err, instances) {
                    if (err) {
                        next(err);
                    } else {
                        var cnapiInsts = instances.filter(function (i) {
                            return (i.service === 'cnapi');
                        });
                        cnAgentInsts = instances.filter(function (i) {
                            return (i.service === 'cn-agent');
                        });
                        var parts = cnapiInsts[0].version.split('-');
                        var curImg = parts[parts.length - 2];
                        if (UpdateAgentV1.MIN_CNAPI_VERSION > curImg) {
                            next(new UpdateError(format(
                                'image for cnapi is too old for ' +
                                '`sdcadm update agents` (min image build ' +
                                'date is "%s" current image build date is' +
                                '"%s")',
                                UpdateAgentV1.MIN_CNAPI_VERSION,
                                curImg
                            )));
                        } else {
                            next();
                        }
                    }
                });
            },
            function updateAgentOnServers(_, next) {
                progress('Proceeding with the individual agent updates on ' +
                        'each server');

                // Check task completion by taskid when we are updating
                // anything but cn-agent:
                function waitUntilTaskCompletes(taskid, _cb) {
                    var counter = 0;
                    var limit = 60;
                    function _waitTask() {
                        counter += 1;
                        sdcadm.cnapi.getTask(taskid, function (err, task) {
                            if (err) {
                                return _cb(new SDCClientError(err, 'cnapi'));
                            }

                            if (task.status === 'failure') {
                                var msg = format('Task %s failed', taskid);
                                if (task.history[0].event.error) {
                                    msg += ' with error: ' +
                                        task.history[0].event.error.message;
                                }
                                return _cb(new UpdateError(msg));
                            } else if (task.status === 'complete') {
                                return _cb();
                            } else if (counter < limit) {
                                return setTimeout(_waitTask, 5000);
                            } else {
                                var message = format(
                                    'Timeout(5m) waiting for task %s', taskid);
                                progress(message);
                                return _cb(new UpdateError(message));
                            }
                        });
                    }
                    _waitTask();
                }
                // Check sysinfo has changed and contains the new image uuid
                // when we are updating cn-agent
                function waitUntilAgentsChange(server_uuid, _cb) {
                    var counter = 0;
                    var limit = 60;
                    function _waitServer() {
                        counter += 1;
                        sdcadm.cnapi.getServer(server_uuid,
                                function (err, server) {
                            if (err) {
                                return _cb(new SDCClientError(err, 'cnapi'));
                            }
                            var theAgent = server.agents.filter(
                                    function (a) {
                                return (a.name === 'cn-agent');
                            })[0];

                            if (theAgent.image_uuid === change.image.uuid) {
                                return _cb();
                            } else if (counter < limit) {
                                return setTimeout(_waitServer, 5000);
                            } else {
                                var msg = format('Timeout(5m) waiting for ' +
                                        'cn-agent update on server %s',
                                        server_uuid);
                                progress(msg);
                                return _cb(new UpdateError(msg));
                            }
                        });
                    }
                    _waitServer();
                }
                function upAgent(arg, cb) {
                    log.debug({
                        arg: arg
                    }, 'upAgent instance');

                    progress('Updating %s on server %s',
                            arg.service, arg.server);

                    var cnAgentInstance = (arg.service === 'cn-agent') ? arg :
                        cnAgentInsts.filter(function (i) {
                            return (i.server === arg.server);
                        })[0];

                    if (!arg.image) {
                        errs.push(new UpdateError(format('Unknown image for ' +
                            '%s in server %s', arg.service, arg.server)));
                        return cb();
                    }

                    if (!cnAgentInstance.version) {
                        errs.push(new UpdateError(format('Unknown version' +
                            ' for cn-agent in server %s', arg.server)));
                        return cb();
                    }

                    // Check if HN/CN has the minimal required cn-agent version
                    // to be able to update agents:
                    if (!(semver.satisfies('1.4.0', cnAgentInstance.version) ||
                        semver.ltr('1.4.0', cnAgentInstance.version))) {
                        errs.push(new UpdateError(format('Invalid ' +
                            'cn-agent version in server %s. Minimal ' +
                            'version to run agent updates is 1.4.0 (current ' +
                            'version is %s)',
                            arg.server, cnAgentInstance.version)));
                        return cb();
                    }

                    return sdcadm.cnapi.post({
                        path: format('/servers/%s/install-agent',
                                      arg.server)
                    }, {
                        image_uuid: change.image.uuid
                    }, function cnapiCb(er2, res) {
                        if (er2) {
                            return cb(new SDCClientError(er2, 'cnapi'));
                        }
                        progress('Waiting for install_agent task to ' +
                                'complete on server %s', arg.server);

                        var fun, argum;
                        if (arg.service === 'cn-agent') {
                            fun = waitUntilAgentsChange;
                            argum = arg.server;
                        } else {
                            fun = waitUntilTaskCompletes;
                            argum = res.id;
                        }

                        return fun(argum, function (er3) {
                            if (er3) {
                                errs.push(er3);
                            } else {
                                progress('Agent %s successfully updated ' +
                                    'on server %s',
                                    arg.service, arg.server);
                            }
                            cb();
                        });
                    });
                }

                var queue = vasync.queue(upAgent, UpdateAgentV1.CN_CONCUR);
                queue.push(change.insts); // No need for per task done cb
                queue.close();
                queue.on('end', function done() {
                    progress('All the instances have been processed. Errors' +
                        ', if any, will be reported below.');
                    if (errs.length) {
                        next(new MultiError(errs));
                    } else {
                        next();
                    }
                });
            }
        ]}, nextSvc);
    }

    vasync.forEachPipeline({
        inputs: self.changes,
        func: updateAgent
    }, callback);

};

//---- exports

module.exports = {
    UpdateAgentV1: UpdateAgentV1
};
// vim: set softtabstop=4 shiftwidth=4: