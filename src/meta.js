"use strict";

var fs = require('fs'),
	path = require('path'),
	async = require('async'),
	winston = require('winston'),
	nconf = require('nconf'),
	_ = require('underscore'),
	less = require('less'),
	fork = require('child_process').fork,
	rimraf = require('rimraf'),
	mkdirp = require('mkdirp'),

	utils = require('./../public/src/utils'),
	translator = require('./../public/src/translator'),
	db = require('./database'),
	plugins = require('./plugins'),
	User = require('./user');

var Meta = {};

Meta.restartRequired = false;
Meta.config = {};

Meta.configs = require('./meta/configs')(Meta);
Meta.themes = require('./meta/themes')(Meta);

Meta.title = {
	tests: {
		isCategory: /^category\/\d+\/?/,
		isTopic: /^topic\/\d+\/?/,
		isUserPage: /^user\/[^\/]+(\/[\w]+)?/
	},
	build: function (urlFragment, language, callback) {
		Meta.title.parseFragment(decodeURIComponent(urlFragment), language, function(err, title) {
			if (err) {
				title = Meta.config.browserTitle || 'NodeBB';
			} else {
				title = (title ? title + ' | ' : '') + (Meta.config.browserTitle || 'NodeBB');
			}

			callback(null, title);
		});
	},
	parseFragment: function (urlFragment, language, callback) {
		var	translated = ['', 'recent', 'unread', 'users', 'notifications'];
		if (translated.indexOf(urlFragment) !== -1) {
			if (!urlFragment.length) {
				urlFragment = 'home';
			}

			translator.translate('[[pages:' + urlFragment + ']]', language, function(translated) {
				callback(null, translated);
			});
		} else if (this.tests.isCategory.test(urlFragment)) {
			var cid = urlFragment.match(/category\/(\d+)/)[1];

			require('./categories').getCategoryField(cid, 'name', function (err, name) {
				callback(null, name);
			});
		} else if (this.tests.isTopic.test(urlFragment)) {
			var tid = urlFragment.match(/topic\/(\d+)/)[1];

			require('./topics').getTopicField(tid, 'title', function (err, title) {
				callback(null, title);
			});
		} else if (this.tests.isUserPage.test(urlFragment)) {
			var	matches = urlFragment.match(/user\/([^\/]+)\/?([\w]+)?/),
				userslug = matches[1],
				subpage = matches[2];

			User.getUsernameByUserslug(userslug, function(err, username) {
				if (subpage) {
					translator.translate('[[pages:user.' + subpage + ', ' + username + ']]', language, function(translated) {
						callback(null, translated);
					});
				} else {
					callback(null, username);
				}
			});
		} else {
			callback(null);
		}
	}
};

Meta.js = {
	cache: undefined,
	prepared: false,
	scripts: [
		'vendor/jquery/js/jquery.js',
		'vendor/jquery/js/jquery-ui-1.10.4.custom.js',
		'vendor/jquery/timeago/jquery.timeago.min.js',
		'vendor/jquery/js/jquery.form.min.js',
		'vendor/bootstrap/js/bootstrap.min.js',
		'vendor/requirejs/require.js',
		'vendor/bootbox/bootbox.min.js',
		'vendor/tinycon/tinycon.js',
		'vendor/xregexp/xregexp.js',
		'vendor/xregexp/unicode/unicode-base.js',
		'src/utils.js',
		'src/app.js',
		'src/templates.js',
		'src/ajaxify.js',
		'src/variables.js',
		'src/widgets.js',
		'src/translator.js',
		'src/helpers.js',
		'src/overrides.js'
	],
	minFile: 'nodebb.min.js',
	prepare: function (callback) {
		plugins.fireHook('filter:scripts.get', this.scripts, function(err, scripts) {
			var ctime,
				jsPaths = scripts.map(function (jsPath) {
					jsPath = path.normalize(jsPath);

					// The filter:scripts.get plugin will be deprecated as of v0.5.0, specify scripts in plugin.json instead
					if (jsPath.substring(0, 7) === 'plugins') {
						var	matches = _.map(plugins.staticDirs, function(realPath, mappedPath) {
							if (jsPath.match(mappedPath)) {
								return mappedPath;
							} else {
								return null;
							}
						}).filter(function(a) { return a; });

						if (matches.length) {
							var	relPath = jsPath.slice(('plugins/' + matches[0]).length),
								pluginId = matches[0].split(path.sep)[0];

							winston.warn('[meta.scripts.get (' + pluginId + ')] filter:scripts.get is deprecated, consider using "scripts" in plugin.json');
							return plugins.staticDirs[matches[0]] + relPath;
						} else {
							winston.warn('[meta.scripts.get] Could not resolve mapped path: ' + jsPath + '. Are you sure it is defined by a plugin?');
							return null;
						}
					} else {
						return path.join(__dirname, '..', '/public', jsPath);
					}
				});

			// Remove scripts that could not be found (remove this line at v0.5.0)
			Meta.js.scripts = jsPaths.filter(function(path) {
				return path !== null;
			});

			// Add plugin scripts
			Meta.js.scripts = Meta.js.scripts.concat(plugins.clientScripts);

			Meta.js.prepared = true;
			callback();
		});
	},
	minify: function(minify) {
		// Prepare js for minification/concatenation
		var minifier = this.minifierProc = fork('minifier.js');

		minifier.on('message', function(payload) {
			if (payload.action !== 'error') {
				winston.info('[meta/js] Compilation complete');
				Meta.js.cache = payload.data;
				minifier.kill();
			} else {
				winston.error('[meta/js] Could not compile client-side scripts!');
				winston.error('[meta/js]   ' + payload.error.message);
				minifier.kill();
				process.exit();
			}
		});

		this.prepare(function() {
			minifier.send({
				action: minify ? 'js.minify' : 'js.concatenate',
				scripts: Meta.js.scripts
			});
		});
	},
	killMinifier: function(callback) {
		if (this.minifierProc) {
			this.minifierProc.kill('SIGTERM');
		}
	}
};

/* Themes */
Meta.css = {};
Meta.css.cache = undefined;
Meta.css.minify = function() {
	winston.info('[meta/css] Minifying LESS/CSS');
	db.getObjectFields('config', ['theme:type', 'theme:id'], function(err, themeData) {
		var themeId = (themeData['theme:id'] || 'nodebb-theme-vanilla'),
			baseThemePath = path.join(nconf.get('themes_path'), (themeData['theme:type'] && themeData['theme:type'] === 'local' ? themeId : 'nodebb-theme-vanilla')),
			paths = [
				baseThemePath,
				path.join(__dirname, '../node_modules'),
				path.join(__dirname, '../public/vendor/fontawesome/less')
			],
			source = '@import "./theme";\n@import "font-awesome";',
			x, numLESS, numCSS;

		// Add the imports for each LESS file
		for(x=0,numLESS=plugins.lessFiles.length;x<numLESS;x++) {
			source += '\n@import "./' + plugins.lessFiles[x] + '";';
		}

		// ... and for each CSS file
		for(x=0,numCSS=plugins.cssFiles.length;x<numCSS;x++) {
			source += '\n@import (inline) "./' + plugins.cssFiles[x] + '";';
		}

		var	parser = new (less.Parser)({
				paths: paths
			});

		parser.parse(source, function(err, tree) {
			if (err) {
				winston.error('[meta/css] Could not minify LESS/CSS: ' + err.message);
				process.exit();
			}

			Meta.css.cache = tree.toCSS({
				cleancss: true
			});
			winston.info('[meta/css] Done.');
		});
	});
};

/* Sounds */
Meta.sounds = {};
Meta.sounds.init = function() {
	var	soundsPath = path.join(__dirname, '../public/sounds');

	plugins.fireHook('filter:sounds.get', [], function(err, filePaths) {
		if (err) {
			winston.error('Could not initialise sound files:' + err.message);
		}

		// Clear the sounds directory
		async.series([
			function(next) {
				rimraf(soundsPath, next);
			},
			function(next) {
				mkdirp(soundsPath, next);
			}
		], function(err) {
			if (err) {
				winston.error('Could not initialise sound files:' + err.message);
			}

			// Link paths
			async.each(filePaths, function(filePath, next) {
				fs[process.platform !== 'win32' ? 'symlink' : 'link'](filePath, path.join(soundsPath, path.basename(filePath)), 'file', next);
			}, function(err) {
				if (!err) {
					winston.info('[sounds] Sounds OK');
				} else {
					winston.error('[sounds] Could not initialise sounds: ' + err.message);
				}
			});
		});
	});
};

Meta.sounds.getFiles = function(callback) {
	// todo: Possibly move these into a bundled module?
	fs.readdir(path.join(__dirname, '../public/sounds'), function(err, files) {
		var	localList = {};

		if (err) {
			winston.error('Could not get local sound files:' + err.message);
			console.log(err.stack);
			return callback(null, []);
		}

		// Return proper paths
		files.forEach(function(filename) {
			localList[filename] = nconf.get('relative_path') + '/sounds/' + filename;
		});

		callback(null, localList);
	});
};

Meta.sounds.getMapping = function(callback) {
	db.getObject('settings:sounds', function(err, sounds) {
		if (err || !sounds) {
			// Send default sounds
			var	defaults = {
					'notification': 'notification.mp3',
					'chat-incoming': 'waterdrop-high.mp3',
					'chat-outgoing': 'waterdrop-low.mp3'
				};

			return callback(null, defaults);
		}

		callback.apply(null, arguments);
	});
};

/* Settings */
Meta.settings = {};
Meta.settings.get = function(hash, callback) {
	hash = 'settings:' + hash;
	db.getObject(hash, function(err, settings) {
		if (err) {
			callback(err);
		} else {
			callback(null, settings || {});
		}
	});
};

Meta.settings.getOne = function(hash, field, callback) {
	hash = 'settings:' + hash;
	db.getObjectField(hash, field, callback);
};

Meta.settings.set = function(hash, values, callback) {
	hash = 'settings:' + hash;
	db.setObject(hash, values, callback);
};

Meta.settings.setOne = function(hash, field, value, callback) {
	hash = 'settings:' + hash;
	db.setObjectField(hash, field, value, callback);
};

Meta.settings.setOnEmpty = function (hash, field, value, callback) {
	Meta.settings.getOne(hash, field, function (err, curValue) {
		if (err) {
			return callback(err);
		}

		if (!curValue) {
			Meta.settings.setOne(hash, field, value, callback);
		} else {
			callback();
		}
	});
};

/* Assorted */
Meta.restart = function() {
	if (process.send) {
		process.send({
			action: 'restart'
		});
	} else {
		winston.error('[meta.restart] Could not restart, are you sure NodeBB was started with `./nodebb start`?');
	}
};


module.exports = Meta;
