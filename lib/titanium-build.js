'use babel';

import fs from 'fs';
import path from 'path';
import _ from 'lodash';
import TargetsView from './targets-view';
import util from 'util';
import expandHomeDir from 'expand-home-dir';
import {
    Task,
    BufferedProcess,
    File
}
from 'atom';
import EventEmitter from 'events';
import Plist from 'plist';
import glob from 'glob';
import JSON2 from 'comment-json';
var tiappFile = null;
var ERROR_MATCH = [
    'Script Error at (?:file://)?(?<file>[^:]+?):(?<line>[0-9]+):((?<column>[0-9]+):)?"(?<message>.+)"'
];
var history = [];
var targetsView;
var multipleFolders = false;
var projectSDK;
var buildConfigs = [];
var currentPath;

var settings = {
    outputDir: 'dist',
    defaultKeychain: null
};

function runTiCmd(params) {
    return new Promise((resolve, reject) => {
        console.log('runTiCmd', params);
        console.log('titanium', params.args.join(' '));
        var _stdout = '';
        new BufferedProcess({
                command: 'titanium',
                args: params.args,
                stdout: function(e) {
                    _stdout += e;
                },
                stderr: function(error) {
                    // No need to show notices, notice come by Longjohn
                    if (error.indexOf('NOTICE:') === 0) {
                        return;
                    }
                    atom.notifications.addError('Titanium error', {
                        detail: error
                    });
                    reject(error);
                }
            })
            .process.on('exit', function() {
                if (params.args.indexOf('json') !== -1) {
                    resolve(JSON.parse(_stdout));
                } else {
                    resolve(_stdout);
                }
            });
    });
}

function tiCreateBuildTarget(_params) {
    return getSDKVersion(currentPath)
        .then(function(_result) {
            var args = ['build', '--platform', _params.platform,
        '--log-level', _params.loggingLevel || 'debug', '--sdk', _result,
        '--project-dir', currentPath, '--color'];
            if (_params.platform === 'ios' && _params.iosVersion) {
                args.push('--ios-version', _params.iosVersion);
            }
            if (_params.args) {
                args = args.concat(_params.args);
            }
            return {
                exec: 'titanium',
                name: _params.name,
                cwd: currentPath,
                sh: false,
                args: args,
                atomCommandName: 'titanium:build:' + (_params.id || _params.name)
                    .replace(' ', '_'),
                liveErrorMatch: true,
                errorMatch: ERROR_MATCH
            };
        });
}

function onMenu(_command) {
    if (!isTitaniumProject()) {
        switch (_command) {
            case 'history':
            case 'last':
                atom.commands.dispatch(atom.views.getView(atom.workspace), 'build:select-active-target');
            break;
            default:
                atom.commands.dispatch(atom.views.getView(atom.workspace), 'build:trigger');
                break;
        }
        return;
    }
    console.log('onMenu', _command);
    console.log('history', history);
    switch (_command) {
        case 'clean':
            runTarget({
                exec: 'titanium',
                name: 'Titanium clean build',
                args: ['clean', '--project-dir', currentPath],
                atomCommandName: 'titanium:build:clean',
                errorMatch: ERROR_MATCH
            }, false);
            break;
        case 'last':
            if (history.length > 0) {
                runTarget(history[0], false);
                return;
            }
            break;
        case 'history':
            if (history.length > 0) {
                showHistory();
                return;
            }
            break;
    }
    console.log('paths', atom.project.getPaths());
    var length = atom.project.getPaths()
        .length;
    multipleFolders = length > 0;
    if (length === 0) {
        atom.notifications.addError('Must have a project open');
        return;
    } else if (length === 1) {
        currentPath = atom.project.getPaths()[0];
        pickPlatform();
    }
}

function selectInList(_list) {
    console.log('selectInList', _list);
    return getTargetView()
        .setItems(_list)
        .awaitSelection()
        .catch((err) => {
            targetsView = null;
            targetsView.setError(err.message);
        });
}

function pickPlatform() {
    var platforms = ['android', 'ios', 'mobileweb', 'clean'];
    if (!multipleFolders && history.length > 0) {
        platforms.unshift('most recent configuration');
    }
    selectInList(platforms)
        .then((_platform) => {
            console.log('pickPlatform', _platform);
            switch (_platform) {
                case 'most recent configuration':
                    runTarget(history[0]);
                    break;
                case 'ios':
                    selectInList(['simulator', 'simulator auto',
                'device', 'device-adhoc', 'dist-adhoc', 'dist-appstore'])
                        .then(runIOSTarget);
                    break;
                case 'android':
                    selectInList(['emulator', 'emulator auto', 'device', 'dist-adhoc', 'dist-playstore'])
                        .then(runAndroidTarget);
                    break;

                case 'clean':
                    onMenu(_platform);
                    break;
            }
        });

}

function loadIOSInfo(_target) {
    return runTiCmd({
            args: ['info', '--types', 'ios', '--log-level', 'error', '--output', 'json']
        })
        .then(function(_result) {
            console.log(_result);
            var result = {
                keychains: {},
                profiles: [],
                simulators: [],
            };
            if (_result.hasOwnProperty('ios')) {
                var ios = _result.ios;
                if (ios.hasOwnProperty('certs')) {
                    _.each(ios.certs.keychains, function(keychain, key) {
                        if (keychain.developer.length > 0 || keychain.distribution.length > 0) {
                            result.keychains[key] = keychain;
                        }
                    });
                }
                if (ios.hasOwnProperty('provisioning')) {
                    switch (_target) {
                        case 'dist-adhoc':
                            result.profiles = ios.provisioning.adhoc;
                            break;
                        case 'dist-appstore':
                            result.profiles = ios.provisioning.distribution;
                            break;
                        default:
                        case 'device':
                            result.profiles = ios.provisioning.development;
                            break;
                    }
                }
                if (ios.hasOwnProperty('simulators')) {
                    var selectedVersion = ios.selectedXcode.sims[0];
                    result.simulators = ios.simulators.ios[selectedVersion];
                }
            }
            return result;
        });
}

function loadAndroidInfo(_target) {
    return runTiCmd({
            args: ['info', '--types', 'android', '--log-level', 'error', '--output', 'json']
        })
        .then(function(_result) {
            console.log(_result);
            var result = {
                keychains: {},
                profiles: [],
                simulators: [],
            };
            if (_result.hasOwnProperty('android')) {
                var android = _result.android;
                if (android.hasOwnProperty('emulators')) {
                    result.emulators = android.emulators;
                } else if (android.hasOwnProperty('avds')) {
                    result.avds = android.avds;
                }
            }
            return result;
        });
}

function parsePlist(_path) {
    var data = fs.readFileSync(_path, 'utf8');
    var begin = data.indexOf('<?xml');
    var end = data.indexOf('</plist>') + '</plist>'.length;
    return Plist.parse(data.substring(begin, end));
}

function handleIOSCertificate(_params) {
    //handling certificate
    var certsPath = path.join(currentPath, 'certs');
    if (fs.existsSync(certsPath)) {
        if (_params.target === 'device') {
            certsPath = path.join(certsPath, 'development.mobileprovision');
        } else if (_params.target === 'dist-appstore') {
            certsPath = path.join(certsPath, 'appstore.mobileprovision');
        } else { //dist-adhoc, device-adhoc
            certsPath = path.join(certsPath, 'distribution.mobileprovision');
        }
        console.log('certsPath', certsPath);
        var plist = parsePlist(certsPath);
        if (plist) {
            var UUID = plist.UUID;
            var TeamName = plist.TeamName;
            var TeamIdentifier = plist.TeamIdentifier[0];
            var TeamFull = TeamName + ' (' + TeamIdentifier + ')';
            _params.profileUUID = UUID;
            var toCopyPath = path.join(expandHomeDir('~/Library/MobileDevice/Provisioning Profiles'), UUID + '.mobileprovision');
            if (!fs.existsSync(toCopyPath)) {
                fs.createReadStream(certsPath)
                    .pipe(fs.createWriteStream(toCopyPath));
            }
            if (_params.target == 'device') {
                _params.args.push('--developer-name', TeamFull);
            } else {
                _params.args.push('--distribution-name', TeamFull);
            }
        }
    }
    return _params;
}

function handleKeyChain(_infos, _name) {
    var keychain = _infos.keychains[_name];
}

function updateIOsBuildInTiApp() {
    const tiappPath = path.join(currentPath, 'tiapp.xml');
    if (fs.existsSync(tiappPath)) {
        var data = fs.readFileSync(tiappPath, 'utf8');
        var match = /(?:<key>CFBundleVersion<\/key>)(?:\s*<string>)([\d]*)(?=<\/string>)/g.exec(data);
        if (match) {
            const version = parseInt(match[1]) + 1;
            console.log('updating tiapp CFBundleVersion to', version);
            data = data.replace(/<key>CFBundleVersion<\/key>\s*<string>[\d]*<\/string>/,
                '<key>CFBundleVersion</key><string>' + version + '</string>');
            fs.writeFileSync(tiappPath, data);
        }
    }
}

function updateAndroidBuildInTiApp() {
    const tiappPath = path.join(currentPath, 'tiapp.xml');
    if (fs.existsSync(tiappPath)) {
        var data = fs.readFileSync(tiappPath, 'utf8');
        var match = /(?:android:versionCode=")([\d]*)(?=")/g.exec(data);
        if (match) {
            const version = parseInt(match[1]) + 1;
            console.log('updating tiapp android versionCode to', version);
            data = data.replace(/android:versionCode="[\d]*"/,
                'android:versionCode="' + version + '"');
            fs.writeFileSync(tiappPath, data);
        }
    }
}

function getSettings(_settings, _default) {
    var files = glob.sync('*.sublime-project', {
        cwd: currentPath,
        nosort: true,
        cache: true,
        nodir: true
    });
    if (files) {
        try {
            var jsonFile = path.join(currentPath, files[0]);
            var json = JSON2.parse(fs.readFileSync(jsonFile).toString());
            if (_.isString(_settings)) {
                return json.settings[_settings] || _default;
            } else {
                return _.defaults(_.pick(json.settings, _settings), _default);
            }
        } catch (e) {
            console.error(e);
        }
    }
    return _default;
}

function runAndroidTarget(_target) {
    var params = {
        name: _target,
        args: [],
        target: _target,
        platform: 'android',
    };
    switch (_target) {
        case 'emulator auto':
            tiCreateBuildTarget(params)
                .then(runTarget);
            break;
        case 'emulator':
            getTargetView()
                .setItems([])
                .setLoading('loading...')
                .show();
            loadAndroidInfo(_target)
                .then((_result) => {
                    var items = (_result.simulators || _result.avds)
                        .map(sim => sim.id || {
                            title: sim.name,
                            subtitle: sim.target
                        });
                    selectInList((_result.simulators || _result.avds)
                            .map((sim, index) => ({
                                index: index,
                                title: sim.name,
                                subtitle: sim.target
                            })))
                        .then(function(obj) {
                            var sim = (_result.simulators || _result.avds)[obj.index];
                            if (sim) {
                                params.args.push(_result.simulators ? '--device-id' : 'avd-id', sim.name);
                            }
                            tiCreateBuildTarget(params)
                                .then(runTarget);
                        });
                });
            break;
        default: //device, device-adhoc dist-adhoc, dist-appstore
            params.args.push('--output-dir', path.join(currentPath, settings.outputDir));
            if (_target === 'device') {
                params.args.push('--deploy-type', 'development');
            } else if (_target !== 'dist-playstore') {
                //dist-adhoc, device-adhoc
                params.args.push('--deploy-type', 'test');
            }

            if (_target === 'dist-playstore') {
                const certsPath = path.join(currentPath, 'certs');
                if (fs.existsSync(certsPath)) {
                    var projectSettings = getSettings(['titanium_android.store-password',
                'titanium_android.alias', 'titanium_android.keystore'], {
                        'titanium_android.keystore': 'android.keystore'
                    });
                    params.args.push('--store-password', projectSettings['titanium_android.store-password']);
                    params.args.push('--alias', projectSettings['titanium_android.alias']);
                    params.args.push('--keystore', path.join(certsPath, projectSettings['titanium_android.keystore']));
                }
            }
            if (/dist/.test(params.target)) {
                updateAndroidBuildInTiApp();
            }
            if (params.target === 'dist-adhoc') {
                params.target = 'device';
            }
            params.args.push('--target', params.target);
            tiCreateBuildTarget(params)
                .then(runTarget);

            break;
    }
}

function runIOSTarget(_target) {
    var params = {
        name: _target,
        args: [],
        target: _target,
        platform: 'ios',
    };
    switch (_target) {
        case 'simulator auto':
            tiCreateBuildTarget(params)
                .then(runTarget);
            break;
        case 'simulator':
            getTargetView()
                .setItems([])
                .setLoading('loading...')
                .show();
            loadIOSInfo(_target)
                .then((_result) => {
                    var items = _result.simulators.map(sim => sim.id || {
                        title: sim.name,
                        subtitle: sim.udid
                    });
                    selectInList(items)
                        .then(function(_sim) {
                            var index = items.indexOf(_sim);
                            var sim = _result.simulators[index];
                            if (sim) {
                                params.name = sim.name;
                                params.args.push('--device-id', sim.udid, '--device-family', 'universal');
                            }
                            tiCreateBuildTarget(params)
                                .then(runTarget);
                        });
                });
            break;
        default: //device, device-adhoc dist-adhoc, dist-appstore
            getTargetView()
                .setItems([])
                .setLoading('loading...')
                .show();
            selectInList(['iphone', 'ipad', 'universal'])
                .then((_family) => {
                    params.args.push('--device-family', _family);
                    if (_target !== 'device' ||
                        _target === 'dist-adhoc') {
                        params.args.push('--output-dir', path.join(currentPath, settings.outputDir), '--device-id', 'all');
                    }
                    if (_target === 'device') {
                        params.args.push('--deploy-type', 'development');
                    } else if (_target !== 'dist-appstore') {
                        //dist-adhoc, device-adhoc
                        params.args.push('--deploy-type', 'test');
                    }
                    return params;
                })
                .then(handleIOSCertificate)
                .then((_params) => {
                    if (/dist/.test(_params.target)) {
                        updateIOsBuildInTiApp();
                    }
                    if (_params.target === 'device-adhoc') {
                        _params.target = 'dist-adhoc';
                    }
                    _params.args.push('--target', _params.target);
                    if (_params.profileUUID) {
                        _params.args.push('--pp-uuid', _params.profileUUID);
                    }
                    if (_params.certificate && target == 'device') {
                        _params.args.push('--developer-name', _params.certificate);
                    }
                    if (_target !== 'device') {
                        tiCreateBuildTarget(params)
                            .then(runTarget);
                    } else {
                        //target is device!
                        loadIOSInfo(_target)
                            .then((_infos) => {
                                if (settings.defaultKeychain && _infos.keychains.hasOwnProperty(settings.defaultKeychain)) {
                                    return _infos.keychains[_name];
                                } else if (_.size(_infos.keychains) > 1) {
                                    return selectInList(_.keys(_infos.keychains))
                                        .then(_keychain => infos.keychains[_name]);
                                } else {
                                    return _infos.keychains[_.keys(_infos.keychains)[0]];
                                }
                            })
                            .then((_keychain) => {
                                var certs = _keychain[(/device/.test(_params.target)) ? 'developer' : 'distribution'];
                                selectInList(certs.map(cert => cert.name))
                                    .then(certName => {
                                        _params.args.push('--developer-name', certName);
                                        tiCreateBuildTarget(params)
                                            .then(runTarget);
                                    });
                            });

                    }
                });
            break;
    }
}

function getSDKVersion(_path) {
    return runTiCmd({
        args: ['project', 'sdk-version', '--project-dir', _path, '--log-level', 'error', '--output', 'json']
    });
}

function getTargetView() {
    if (!targetsView) {
        targetsView = new TargetsView();
    }
    return targetsView;
}

function showHistory() {
    selectInList(history.map((target, index) => ({
            index: index,
            title: (target.projectName + ' / ' + target.name),
            subtitle: target.args.join(' ')
        })))
        .then(obj => {
            // console.log('obj', obj);
            var target = history[obj.index];
            history.splice(obj.index, 1);
            history.unshift(target);
            runTarget(target, false);
        });
}

function runTarget(_target, _history) {
    _target.projectName = path.basename(currentPath);
    console.log('runTarget', _target, _history);
    if (_history !== false) {
        history.unshift(_target);
        history = _.take(history, 10);
    }
    buildConfigs = [_target];
    atom.commands.dispatch(atom.views.getView(atom.workspace), 'build:refresh-targets');
    setTimeout(function() {
        atom.commands.dispatch(atom.views.getView(atom.workspace), _target.atomCommandName);
    }, 50);
    getTargetView()
        .hide();
}

function isTitaniumProject(wanrUser) {
    var exists = false;
    _.each(atom.project.getPaths(), function(_path) {
        if (fs.existsSync(path.join(_path, 'tiapp.xml'))) {
            exists = true;
            return true;
        }
    });
    if (!exists && wanrUser) {
        atom.notifications.addWarning("Not a Titanium project, can't reach tiapp.xml");
    }
    return exists;
}

export function activate() {
    atom.commands.add('atom-workspace', 'titanium-build:run', onMenu);
    atom.commands.add('atom-workspace', 'titanium-build:clean', _.partial(onMenu, 'clean'));
    atom.commands.add('atom-workspace', 'titanium-build:last', _.partial(onMenu, 'last'));
    atom.commands.add('atom-workspace', 'titanium-build:history', _.partial(onMenu, 'history'));
};

export function provideBuilder() {
    return class TitaniumBuildProvider extends EventEmitter {
        constructor(cwd) {
            super();
            this.cwd = cwd;
        }

        destructor() {}

        getNiceName() {
            return 'Titanium builder';
        }

        isEligible() {
            return isTitaniumProject();
        }
        settings() {
            return buildConfigs;
        }
    };
}
