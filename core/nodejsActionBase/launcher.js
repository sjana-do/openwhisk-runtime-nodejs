/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const useLambdaRunner = require('/nodejsAction/useLambdaRunner');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { NodeActionRunner } = require('/nodejsAction/runner');
const NodeActionLambdaRunner = (() => {
  try {
    let lambda = require('/nodejsAction/lambda');
    return lambda;
  } catch (e) {}
})();

// Substituted by bin/compile with the action main (e.g. "main" or "file.func").
const MAIN_SPEC = '##MAIN##';

/**
 * Splits handler into module name and path to main.
 * If the string contains no '.', return [ undefined, the string ].
 * If the string contains one or more '.', return [ string up to first period, rest of the string after ].
 * Mirrors runner.js splitMainHandler.
 */
function splitMainHandler(handler) {
  let matches = handler.match(/^([^.]+)$|^([^.]+)\.(.+)$/);
  if (matches && matches.length == 4) {
    let index = matches[2];
    let main = matches[3] || matches[1];
    return [index, main];
  }
  return undefined;
}

/**
 * Resolve the user entry file under moduleDir.
 * Mirrors initializeActionHandler's zip-branch resolution in runner.js.
 */
function resolveMainFile(moduleDir, index) {
  const packageJsonExists = fs.existsSync(path.join(moduleDir, 'package.json'));
  const indexMJSExists = fs.existsSync(path.join(moduleDir, 'index.mjs'));

  let mainFile;
  if (index !== undefined) {
    // Backwards compat: main definitions like `file.a.b.c` import a.b.c from file.[m]js.
    if (fs.existsSync(path.join(moduleDir, index + '.js'))) {
      mainFile = index + '.js';
    } else if (fs.existsSync(path.join(moduleDir, index + '.mjs'))) {
      mainFile = index + '.mjs';
    }
  }
  if (!mainFile && packageJsonExists) {
    let pkg = JSON.parse(fs.readFileSync(path.join(moduleDir, 'package.json'), 'utf8'));
    mainFile = pkg.main;
  }
  if (!mainFile && indexMJSExists) {
    mainFile = 'index.mjs';
  }
  if (!mainFile) {
    mainFile = 'index.js';
  }
  return mainFile;
}

/**
 * Load the user handler via dynamic import() so ESM packages ("type":"module") work
 * on the scriptBasedInit path (used when LOG_DESTINATIONS is set).
 */
function loadHandler(mainSpec) {
  const parts = splitMainHandler(mainSpec);
  if (parts === undefined) {
    return Promise.reject(new Error('Name of main function is not valid.'));
  }
  const [index, main] = parts;
  const moduleDir = process.cwd();
  const mainFile = resolveMainFile(moduleDir, index);
  const absPath = path.join(moduleDir, mainFile);

  return import(pathToFileURL(absPath).href).then(evaled => {
    // Nested export path e.g. a.b.c — same as runner.js: evaled.<main>
    let handler = eval('evaled.' + main);
    if (typeof handler !== 'function') {
      throw new Error("Function entrypoint '" + mainSpec + "' is not a function.");
    }
    return handler;
  });
}

// Create explicit stdout and stderr streams for the sentinels to avoid users tampering with the output.
const stdout = fs.createWriteStream(null, { fd: 1, encoding: 'utf8' });
const stderr = fs.createWriteStream(null, { fd: 2, encoding: 'utf8' });

function writeMarkers() {
  stdout.write('XXX_THE_END_OF_A_WHISK_ACTIVATION_XXX\n');
  stderr.write('XXX_THE_END_OF_A_WHISK_ACTIVATION_XXX\n');
}

async function actionLoop(runner) {
  const out = fs.createWriteStream(null, { fd: 3, encoding: 'utf8' });
  process.stdin.setEncoding('utf8');
  const rl = readline.createInterface({
    input: process.stdin
  });
  // Ack only after the user handler has been loaded successfully.
  out.write(JSON.stringify({ ok: true }) + '\n');
  for await (const line of rl) {
    try {
      let args = JSON.parse(line);
      let value = args.value || {};
      for (let key in args) {
        if (key !== 'value') {
          let envar = '__OW_' + key.toUpperCase();
          process.env[envar] = args[key];
        }
      }
      let result = await runner.run(value).then(result => {
        if (typeof result !== 'object') {
          console.error(`Result must be of type object but has type "${typeof result}":`, result);
        }
        writeMarkers();
        return result;
      });

      out.write(JSON.stringify(result) + '\n');
    } catch (err) {
      console.log(err);
      let message = err.message || err.toString();
      let error = { error: message };
      writeMarkers();
      out.write(JSON.stringify(error) + '\n');
    }
  }
}

loadHandler(MAIN_SPEC)
  .then(handler => {
    const runner = useLambdaRunner(handler)
      ? new NodeActionLambdaRunner(handler)
      : new NodeActionRunner(handler);
    return actionLoop(runner);
  })
  .catch(e => {
    console.log(e);
    process.exit(1);
  });
