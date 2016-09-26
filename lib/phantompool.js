/*

Highcharts Export Server

Copyright (c) 2016, Highsoft

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

*/

const log = require('./logger').log;
const phantomjs = require('phantomjs-prebuilt');

var settings = false,
    workers = [],
    workQueue = [],
    instCount = 0
;

function killAll() {
    workers = workers.filter(function (worker) {
        if (worker.process) {
            worker.process.kill();
        }
        return false;
    });
}

function spawnWorker() {
    var worker = {
        ready: true,
        process: false,
        workStartTime: 0,
        ondone: false,
        workcount: 0,
        id: ++instCount 
    };

    log(4, 'phantom', worker.id, '- spawning worker');

    if (!settings) return log(1, 'phantom', worker.id, '- tried spawning worker, but pool not inited');

    worker.process = phantomjs.exec(settings.worker);
    worker.process.stdin.setEncoding('utf-8');
    worker.process.stdout.setEncoding('utf-8');

    worker.process.on('error', function (err) {
        log(1, 'phantom worker', worker.id, '-', err);
        worker.ready = false;
    });

    worker.process.stdout.on('data', function (data) {
        if (worker.ready) {
            //We're not expecting any data from this worker
            return;
        }

        try {
            data = JSON.parse(data + '\n');
        } catch (e) {
            log(4, 'phantom worker', worker.id, 'unexpected data -', e, data);
            return;
        }

        log(4, 'phantom worker', worker.id, 'finished work in', ((new Date()).getTime() - worker.workStartTime), 'ms');

        if (worker.ondone) {
            worker.ondone(false, data);
            worker.ondone = false;

            //Process the queue
            if (workQueue.length > 0) {
                var item = workQueue[0];
                workQueue.splice(0, 1);
                worker.work(item.data, item.fn);
            }
        }

        worker.ready = true;
    });

    worker.process.stderr.on('data', function (data) {
        log(1, 'phantom worker', worker.id, 'error -', data);
    });

    worker.process.on('close', function (code, signal) {
        log(4, 'phantom worker', worker.id, '- process was closed');
        worker.ready = false;

        if (signal !== 'SIGTERM') {

        }
    });

    worker.work = function (data, fn) {
        if (!worker.ready) return fn && fn ('tried posting work, but the worker is not ready');        
        if (!worker.process) return fn && fn('tried posting work, but no worker process is active');

        if (settings.workLimit && worker.workcount > settings.workLimit) {
            worker.process.kill();
            workers = workers.filter(function (w) {
                return w.id !== worker.id;
            });
            return spawnWorker().work(data, fn);
        }

        worker.workcount++;
        worker.ready = false;
        worker.ondone = fn;
        worker.workStartTime = (new Date()).getTime();

        data.id = worker.id;

        //Send a work start event to the worker script
        log(4, 'phantom', worker.id, '- starting work');

        try {
            //The buffer might fill up, so we send a separate eol signal.
            worker.process.stdin.write(JSON.stringify(data));            
            worker.process.stdin.write('\nEOL\n');            
        } catch (e) {
            log(4, 'phantom', worker.id, '- error starting work', e);
            return fn && fn ('error starting work:', e);   
        }
    };

    workers.push(worker);

    return worker;
}

function init(config) {
    killAll();

    config = config || {};

    settings = {
        maxWorkers: config.maxWorkers || 25,
        initialWorkers: config.initialWorkers || 5,
        worker: config.worker || __dirname + '/../phantom/worker.js',
        //Setting this too high may cause issues, setting it too low causes performance issues..
        workLimit: 50
    };

    for (var i = 0; i < settings.initialWorkers; i++) {
        spawnWorker();
    }
}

function postWork(data, fn) {
    var foundWorker = false;

    if (!settings) return log(1, 'phantom - tried posting work, but pool not initied');
    log(4, 'phantom - received work, finding available worker');

    workers.some(function (worker) {
        if (worker.ready) {
            log(4, 'phantom - found available worker');
            worker.work(data, fn);
            foundWorker = true;
            return true;
        }
    });

    if (!foundWorker) {
        //If we haven't reached max yet, we can just spawn a new one
        if (workers.length < settings.maxWorkers) {
            log(4, 'phantom - pool is not maxed, posting work to new spawn');
            spawnWorker().work(data, fn);
        } else {
            log(4, 'phantom - queuing work');
            workQueue.push({
                data: data,
                fn: fn
            });            
        }
    }
}

module.exports = {
    init: init,
    kill: killAll,
    postWork: postWork
};