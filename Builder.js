'use strict';
const architect = require('architect');
const path = require('path');
const _ = require('lodash');
const fs = require('fs');
const esprima = require('esprima');

let asyncHooks;

const terminator = function (sig) {
    if (typeof sig === 'string') {
        console.log('%s: Received %s - terminating app ...',
            new Date(), sig);
    }
    if (asyncHooks) {
        console.log('%s: Executing cleanup before exit.', new Date());
        asyncHooks.emit('exit', function (e) {
            if (e) {
                console.error(e);
            }
            console.log('%s: Node server stopped.', new Date());
            process.exit(1);
        });
    } else {
        console.log('%s: Node server stopped.', new Date());
        process.exit(1);
    }
};

const setupTerminationHandlers = function () {
    //  Process on exit and signals.
    process.on('exit', function () {
        terminator();
    });
    process.on('error', function (error) {
        console.error(error);
    });

    process.on('unhandledRejection', (reason, p) => {
        console.error('Unhandled Rejection at: Promise', p, 'reason:', reason);
        // application specific logging, throwing an error, or other logic here
    });

    // Removed 'SIGPIPE' from the list - bugz 852598.
    ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT',
        'SIGBUS', 'SIGFPE', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGTERM'
    ].forEach(function (element, index, array) {
        process.on(element, function () {
            terminator(element);
        });
    });
};
setupTerminationHandlers();

/**
 * Builder for building an app using a definition file or dependency array
 */
class Builder {
    constructor({debug = process.env.DEBUG_BUILDER} = {}) {
        console.time('app');
        this.debug = debug;
        this.imports = {};
    }

    /**
     * Goes through the given directory to return all files and folders recursively
     * @author Ash Blue ash@blueashes.com
     * @example getFilesRecursive('./folder/sub-folder');
     * @requires Must include the file system module native to NodeJS, ex. var fs = require('fs');
     * @param {string} folder Folder location to search through
     * @param forceChildrenSearch
     * @returns {object} Nested tree of the found files
     */

    getFilesRecursive(folder, forceChildrenSearch) {
        let fileTree = [];
        try {
            let fileContents = fs.readdirSync(folder);
            if (folder !== 'plugins' && !forceChildrenSearch) {
                fileContents = fileContents.filter((s) => s.startsWith('.plugin-') || s.startsWith('plugin-'));
            }
            let stats;
            fileContents.forEach((fileName) => {
                stats = fs.lstatSync(folder + '/' + fileName);

                if (stats.isDirectory() || stats.isSymbolicLink()) {
                    fileTree.push({
                        name: folder + '/' + fileName,
                        children: this.getFilesRecursive(folder + '/' + fileName, true)
                    });
                } else {
                    fileTree.push({
                        name: fileName
                    });
                }
            });
        } catch (err) {
            this.log(`skipping folder ${folder}`, err);
        }

        return fileTree;
    }

    parseFunctionArguments(func) {
        // allows us to access properties that may or may not exist without throwing
        // TypeError: Cannot set property 'x' of undefined
        const maybe = (x) => (x || {});

        // handle conversion to string and then to JSON AST
        const functionAsString = func.toString().replace(/function\s*\(/, 'function anon(');
        if (functionAsString === {}.toString()) { //if export is an object
            return func.consumes ? [func.consumes, func.provides] : [[], Object.keys(func)];
        }
        const tree = esprima.parse(functionAsString);
        // We need to figure out where the main params are. Stupid arrow functions 👊
        const isArrowExpression = (maybe(_.first(tree.body)).type === 'ExpressionStatement');
        const params = isArrowExpression ? maybe(maybe(_.first(tree.body)).expression).params
            : maybe(_.first(tree.body)).params;

        return _.map(params, (p) => _.get(p, 'name') ||
            _.map(p.properties, (prop) => { //object
                return _.get(prop, 'key.name') || _.get(prop, 'value.name');
            }));
    }

    log() {
        if (this.debug) {
            console.log.apply(console, _.concat('[Builder]', _.toArray(arguments)));
        }
    }

    consume(name, imports, consumes) {
        return _.chain(consumes).map((path) => {
            let key;
            if (path === `options.${name.replace('plugin-', '')}`) {
                key = 'options';
            } else if (path === 'options') {
                key = 'options';
                path = `${path}.${name}`;
            } else {
                key = path;
            }
            let consume = _.get(imports, path);
            if (!consume) {
                console.warn(`consume '${path}' for ${name} == '${consume}'`);
            }
            return [key, consume];
        }).fromPairs().value();
    }

    provide(name, consumes, func, provides = []) {
        return new Promise((resolve, reject) => {
            const result = func(consumes);
            if (result === undefined) {
                resolve();
            }
            if (result && result.then) {
                result.then((r) => {
                    resolve(r);
                }).catch(reject)
            } else {
                resolve(result);
            }
        }).then((result) => {
            if (!result && provides.length || _.values(_.pick(result, provides)).length < provides.length) {
                throw new Error(`Plugin '${name}' didn't provide ${provides.join(', ')}. Instead: ${JSON.stringify(result)}`);
            }
            this.log('provided', name, _.keys(consumes), provides);
            this.imports = _.defaults(this.imports, result);
            return result;
        });
    }

    async build({moduleName = './package.json', defaultPlugin = 'server', folders = ['plugins']}) {
        const packageJson = require(path.resolve(moduleName));
        const serverName = `${packageJson.name}.${packageJson.version}`;
        const services = packageJson.server.concat(defaultPlugin);
        let packageJsons;
        this.log(`Building ${serverName}`);
        try {
            let modules = _.chain(['node_modules', ...folders]).map(this.getFilesRecursive.bind(this)).union().flatten().compact().value();
            packageJsons = await Promise.all(modules.map((dir) => {
                let packageJson;
                let folder = dir.name;
                if (dir.name === 'package.json') {
                    folder = '.';
                    packageJson = true
                } else {
                    packageJson = _.find(dir.children, {name: 'package.json'});
                }

                if (packageJson) {
                    if (folder)
                        return new Promise((resolve, reject) => fs.readFile(folder + '/package.json', 'utf8', (err, json) => {
                            if (err) {
                                return reject(err);
                            } else {
                                try {
                                    return resolve({folder, json: JSON.parse(json)});
                                } catch (err) {
                                    reject(`Invalid json ${folder}`);
                                }
                            }
                        })).catch((err) => {console.log(err);});
                }
            }));
        } catch (err) {
            return this.log(err);
        }
        const pluginsChain = _.chain(packageJsons)
            .filter(_.partial(_.has, _, 'json.plugin'))
            .map((pjson) => ({
                name: pjson.json.name,
                folder: pjson.folder,
                main: pjson.json.main,
                consumes: pjson.json.plugin.consumes,
                provides: pjson.json.plugin.provides,
            }))
            .map(({name, folder, main, consumes, provides}) => {
                let reqPath = path.resolve(folder);
                let req = require(reqPath);
                let setup;
                let func;
                if (req.toString() === {}.toString()) { //is it a constant plugin
                    provides = Object.keys(req);
                    func = _.constant(req);
                } else if (_.isArray(req)) {
                    provides = _.initial(req);
                    func = _.last(req);
                    const params = this.parseFunctionArguments(func);
                    consumes = params[0];
                } else {
                    const params = this.parseFunctionArguments(req);
                    if (params.length === 3) {//legacy options, imports, register
                        setup = req;
                    } else {
                        consumes = params[0];
                        provides = params[1];
                        func = req;
                    }
                }
                consumes = consumes ? _.map(consumes, (c) => c === 'options' ? `options.${name.replace('plugin-', '')}` : c) : [];
                provides = provides || [];

                setup = setup || ((options, imports, register) => {
                    this.provide(name, this.consume(name, imports, consumes), func, provides)
                        .then((result) => {
                            register(null, result);
                        }).catch(register);
                });

                return {
                    name,
                    folder,
                    main,
                    consumes,
                    provides,
                    setup
                }
            })
            .value();

        let requiredConsumes = _.zipObject(services, _.times(services.length, _.constant(serverName)));

        const depTree = {};
        const pluginTree = {};
        const optionProvidesForPlugins = _.chain(pluginsChain)
            .find({name: 'options'})
            .get('provides')
            .map((p) => p.split('.')[1])
            .value();

        function getAdditionalOptionsConsumesForLegacyModule(name) {
            if (optionProvidesForPlugins.includes(name)) {
                return [`options.${name}`];
            }
            return [];
        }

        const serverConfig = _.map(pluginsChain, (p) => ({
            packagePath: path.join('./', p.folder),
            main: p.main,
            name: p.name,
            consumes: _.uniq(p.consumes.concat(getAdditionalOptionsConsumesForLegacyModule(p.name))),
            provides: p.provides,
            setup: p.setup
        }));

        _.each(serverConfig, function (plugin) {
            _.each(plugin.provides, function (provided) {
                depTree[provided] = plugin.consumes;
                pluginTree[provided] = plugin;
            });
        });
        const allDependencies = {};
        const resolvedDependencies = {};
        while (!_.isEmpty(requiredConsumes)) {
            const newRequired = {};
            _.each(requiredConsumes, function (parent, consume) {
                allDependencies[consume] = parent;
                _.each(depTree[consume], function (dependency) {
                    allDependencies[dependency] = consume;
                    if (!resolvedDependencies[dependency]) {
                        newRequired[dependency] = consume;
                        resolvedDependencies[dependency] = consume;
                    }
                });
                resolvedDependencies[consume] = parent;
            });
            requiredConsumes = newRequired;
        }

        const includedPlugins = {};
        let wholeServerConfig = [];

        _.each(allDependencies, function (t, dependency) {
            if (dependency === 'imports') {
                return;
            }
            let plugin = pluginTree[dependency];
            if (!plugin) {
                let currentPlugin = pluginTree[t];
                if (currentPlugin) {
                    throw new Error(`Cannot resolve dependency ${dependency} in ${path.join(currentPlugin.packagePath, currentPlugin.main)}`);
                } else {
                    throw new Error(`Cannot resolve dependency ${dependency} in server ${t}`);
                }
            }
            const packagePath = plugin ? plugin.packagePath : null;
            if (!includedPlugins[packagePath]) {
                wholeServerConfig.push(plugin);
                includedPlugins[packagePath] = true;
            }
        });

        wholeServerConfig.push({
            name: 'imports',
            //consume all dependencies except the system ones imports and require
            consumes: _(wholeServerConfig).reject((s) => s.consumes.indexOf('imports') >= 0).map('provides').flatten().value(),
            provides: ['imports'],
            setup: (options, imports, register) => {
                register(null, {
                    imports
                });
            }
        });

        const Module = require('module');
        const originalRequire = Module.prototype.require;
        const self = this;
        /**
         * requires a module which is imported as a plugin.
         * Usage:
         * ===== in ./plugins/plugin3/module.js
         * module.exports = [({plugin1, plugin2}) => {
                     *  let exported = {}; //the object will be imported
                     *  return exported;
                     * }]
         * ===== in /plugins/plugin3/plugin.js
         * module.exports = ['<some provide', ({}) => {
                     *  const moduleRequired = require('./module');
                     * })]
         * @param module
         * @return {*}
         */
        Module.prototype.require = function (module) {
            const requiredModule = originalRequire.call(this, module);

            let func, consumes;
            if (_.isArray(requiredModule) && requiredModule.length === 1) {// do our builder magic and extract the last fn -> module.exports
                func = _.last(requiredModule);
                const params = self.parseFunctionArguments(func);
                consumes = params[0];
                const parentModule = _.get(_.find(wholeServerConfig, (plugin) => {
                    return this.filename.indexOf(plugin.packagePath) >= 0;
                }), 'name');
                if (!parentModule) {
                    throw new Error(`require'd child module needs to be included in a parent module`);
                }
                let consumeExtracted = self.consume(parentModule, self.imports, consumes);
                return func(consumeExtracted);
            } else {
                return requiredModule;
            }
        };

        return new Promise((resolve, reject) => {
            architect.createApp(wholeServerConfig, function (err, app) {
                if (err) {
                    return reject(err);
                }
                app.name = serverName;
                asyncHooks = _.get(app, 'services.asyncHooks');
                global.app = app;
                console.timeEnd('app');
                if (app.services.database) {
                    _(app.services)
                        .pickBy((val, key) => _.startsWith(key, 'model-sql'))
                        .mapValues(app.services.database.import)
                        .value();
                }
                if (asyncHooks) {
                    try {
                        app.services.afterStart((imports, done) => {
                            done();
                            resolve(app);
                        });
                        asyncHooks.emit('start', app.services);
                    } catch (err) {
                        reject(err);
                    }
                } else {
                    resolve(app);
                }
            });
        });
    }
}

module.exports = Builder;
