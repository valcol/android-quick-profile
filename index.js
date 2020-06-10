#!/usr/bin/env node

/* eslint-disable no-console */
/* eslint-disable no-control-regex */
const asciichart = require('asciichart');
const logUpdate = require('log-update');
const csv = require('csvtojson');
const adb = require('adbkit');
const chalk = require('chalk');
const inquirer = require('inquirer');
const logoCli = require('cli-logo');
const d3 = require('d3-array');
const bars = require('bars');
const sleep = require('util').promisify(setTimeout);
const { description, version } = require('./package.json');

const client = adb.createClient();
const histogramRanges = [0, 16.66, 33.33, 50, 100, 200, 300, 400, 500, 1000];

const formatHistogramRanges = (range) => `More than ${range}ms`;

const baseDatasetValues = {
  entries: new Array(120).fill(0),
  min: Number.MAX_SAFE_INTEGER,
  max: Number.MIN_SAFE_INTEGER,
  average: 0,
  total: 0,
  nbOfEntries: 0,
};

let frames = {
  ...baseDatasetValues,
  jankyFrames: 0,
  histogram: histogramRanges.reduce((acc, range) => ({
    ...acc,
    [formatHistogramRanges(range)]: 0,
  }), {}),
};

const presice = (n) => Number.parseFloat(n).toFixed(2);

const formatOutput = (...args) => args.reduce((t, arg) => `${t}\n${arg}`, '');

const computeBaseDatasetValues = (dataset, entriesToMerge) => {
  const {
    entries, min, max, total, nbOfEntries,
  } = dataset;

  const updatedNbOfEntries = nbOfEntries + entriesToMerge.length;
  const updatedTotal = total + entriesToMerge.reduce((t, n) => t + n, 0);

  return {
    entries: [
      ...entriesToMerge,
      ...entries.slice(0, entries.length - entriesToMerge.length),
    ],
    min: Math.min(min, ...entriesToMerge),
    max: Math.max(max, ...entriesToMerge),
    average: updatedTotal / updatedNbOfEntries,
    total: updatedTotal,
    nbOfEntries: updatedNbOfEntries,
  };
};

const waitForProcessToStart = async (deviceId, packageName) => {
  const process = await client
    .shell(deviceId, 'ps && ps -A')
    .then(adb.util.readAll);
  const regex = RegExp(
    `${packageName}`,
  );
  const wantedProcess = regex.exec(process.toString('utf-8'));
  if (!wantedProcess) {
    await sleep(200);
    return waitForProcessToStart(deviceId, packageName);
  }
  console.log(chalk.green('App started.'));
  return true;
};

const updateFrameInfos = (renderTimings) => {
  const filteredRenderTimings = renderTimings.filter((t) => !Number.isNaN(t));
  if (filteredRenderTimings.length === 0) return;

  const {
    jankyFrames, histogram,
  } = frames;
  const newJankyFrames = filteredRenderTimings.reduce((acc, timing) => (timing > 16.67 ? acc + 1 : acc), 0);
  const bin = d3.bin().thresholds(histogramRanges);
  const bins = bin(filteredRenderTimings);
  const newHistogram = bins.reduce((acc, h) => {
    if (!histogramRanges.includes(h.x0)) {
      return {
        ...acc,
        [formatHistogramRanges(0)]: h.length,
      };
    }
    return {
      ...acc,
      [formatHistogramRanges(h.x0)]: h.length,
    };
  }, {});
  const mergedHistogram = Object.entries(newHistogram).reduce((acc, [key, value]) => ((acc[key]) ? {
    ...acc,
    [key]: acc[key] + value,
  } : { ...acc, [key]: value }),
  histogram);
  frames = {
    ...computeBaseDatasetValues(frames, filteredRenderTimings),
    jankyFrames: jankyFrames + newJankyFrames,
    histogram: mergedHistogram,
  };
};

const getFramesInfosAndroidJL = async (dumpsysOutput, regex) => {
  const profiledataRegex = RegExp(regex);
  const profiledata = profiledataRegex.exec(dumpsysOutput);
  if (!profiledata) return;

  const profiledataJson = await csv({ delimiter: '\t', ignoreEmpty: true, headers: profiledata[1].split('\t') }).fromString(profiledata[2]);
  const renderTimings = profiledataJson.map(
    (data) => Object.values(data).reduce((acc, n) => acc + parseFloat(n), 0),
  );
  if (renderTimings.length === 0) return;

  updateFrameInfos(renderTimings);
};

const getFramesInfosAndroidM = async (dumpsysOutput) => {
  const profiledataRegex = RegExp(
    '(?<=---PROFILEDATA---\n)(.|\n)*?(?=---PROFILEDATA---)',
  );
  const profiledata = profiledataRegex.exec(dumpsysOutput);
  if (!profiledata || !profiledata[0]) return;

  const profiledataJson = await csv().fromString(profiledata[0]);
  const validFrames = profiledataJson.filter(({ Flags }) => Flags === '0');
  if (validFrames.length === 0) return;

  const renderTimings = validFrames.map(
    ({ FrameCompleted, IntendedVsync }) => {
      const renderTimeInMS = (FrameCompleted - IntendedVsync) / 1000000;
      return renderTimeInMS;
    },
  );
  updateFrameInfos(renderTimings);
};


const getFramesInfos = async (deviceId, packageName, APILevel) => {
  const dumpsysOutput = await client
    .shell(deviceId, `dumpsys gfxinfo ${packageName} framestats reset`)
    .then(adb.util.readAll);
  if (APILevel >= 21) {
    getFramesInfosAndroidM(dumpsysOutput.toString());
  } else if (APILevel >= 20) {
    getFramesInfosAndroidJL(dumpsysOutput.toString(), '([\\s]*?Draw[\\s]*?Prepare[\\s]*?Process[\\s]*?Execute[\\s]*?)([\\S\\s]*?)(?=View hierarchy:)');
  } else if (APILevel >= 16) {
    getFramesInfosAndroidJL(dumpsysOutput.toString(), '([\\s]*?Draw[\\s]*?Process[\\s]*?Execute[\\s]*?)([\\S\\s]*?)(?=View hierarchy:)');
  } else {
    console.log(chalk.red('API Level not supported.'));
    process.exit();
  }
};

const getAPILevel = async (deviceId) => {
  const APILevel = await client
    .shell(deviceId, 'getprop ro.build.version.sdk ')
    .then(adb.util.readAll);
  return parseInt(APILevel.toString(), 10);
};

const askForDevice = async () => {
  const devices = await client.listDevices();
  if (!devices || devices.length === 0) {
    console.log(chalk.redBright('No devices/emulator detected.'));
    process.exit();
  }

  const answers = await inquirer
    .prompt([
      {
        type: 'list',
        name: 'deviceId',
        message: 'Please choose a device:',
        choices: devices.map(({ id }) => id),
      },
    ]);
  return answers.deviceId;
};

const askForPackageName = async (deviceId) => {
  const answers = await inquirer
    .prompt([
      {
        name: 'packageName',
        message: 'Please enter the package name (ex: com.google.android.youtube)',
      },
    ]);
  const { packageName } = answers;
  const isInstalled = await client.isInstalled(deviceId, packageName);
  if (!isInstalled) {
    console.log(chalk.red(`Package not detected on ${deviceId}`));
    return askForPackageName(deviceId);
  }
  return packageName;
};

const draw = async (deviceId, packageName, APILevel) => {
  const start = Date.now();
  setInterval(() => {
    try {
      getFramesInfos(deviceId, packageName, APILevel);
      const {
        entries, min, max, average, nbOfEntries, jankyFrames, histogram,
      } = frames;
      logUpdate(
        formatOutput(
          chalk(`Running for ${new Date(Date.now() - start).toISOString().slice(11, -1)}`),
          '',
          chalk.inverse.magenta(' LIVE FRAME TIMINGS ( last 120 frames - ms) '),
          '',
          chalk.magenta(
            asciichart.plot(
              [
                entries,
                [0, 0],
                [16.66, 16.66],
                [33.33, 33.33],
              ],
              {
                height: 10,
                colors: [
                  asciichart.default,
                  asciichart.green,
                  asciichart.yellow,
                  asciichart.red,
                ],
              },
            ),
          ),
          ' ',
          chalk.inverse.cyan(' STATS '),
          ' ',
          chalk.cyan(`Frames rendered: ${nbOfEntries}`),
          chalk.cyan(`Janky frames: ${jankyFrames} (${presice((jankyFrames * 100) / nbOfEntries)}%)`),
          chalk.cyan('Render time:'),
          chalk.cyan(` Max: ${presice(max)}ms`),
          chalk.cyan(` Min: ${presice(min)}ms`),
          chalk.cyan(` Avg: ${presice(average)}ms`),
          ' ',
          chalk.inverse.blue(' FRAME TIMINGS DISTRIBUTION '),
          ' ',
          chalk.blue(bars(histogram, { sort: false })),
          ' ',
        ),
      );
    } catch (e) {
      console.error(e);
      console.log(chalk.redBright('Oops something bad happened.'));
      process.exit();
    }
  }, 200);
};

(async () => {
  logoCli.print({
    name: 'AQP',
    description,
    version: `v${version}`,
  });
  const deviceId = await askForDevice();
  const APILevel = await getAPILevel(deviceId);
  const packageName = await askForPackageName(deviceId);
  console.log(`Waiting for ${packageName} to start...`);
  await waitForProcessToStart(deviceId, packageName);
  draw(deviceId, packageName, APILevel);
})();
