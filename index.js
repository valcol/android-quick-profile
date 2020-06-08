/* eslint-disable no-console */
/* eslint-disable no-control-regex */
const asciichart = require('asciichart');
const logUpdate = require('log-update');
const csv = require('csvtojson');
const adb = require('adbkit');
const chalk = require('chalk');
const inquirer = require('inquirer');
const logoCli = require('cli-logo');
const sleep = require('util').promisify(setTimeout);
const { description, version } = require('./package.json');

const client = adb.createClient();

const getInitialInfos = () => ({
  entries: new Array(120).fill(0),
  min: Number.MAX_SAFE_INTEGER,
  max: Number.MIN_SAFE_INTEGER,
  average: 0,
  total: 0,
  nbOfEntries: 0,
});

const updateInfos = (dataset, entriesToAdds, extraDatas = {}) => {
  const {
    entries, min, max, average, total, nbOfEntries, ...extras
  } = dataset;

  const updatedNbOfEntries = nbOfEntries + entriesToAdds.length;
  const updatedTotal = total + entriesToAdds.reduce((t, n) => t + n);
  const newExtras = Object.entries(extraDatas).reduce((acc, [key, value]) => ((extras[key]) ? {
    ...acc,
    [key]: extras[key] + value,
  } : { ...acc, [key]: value }),
  {});
  return {
    entries: [
      ...entriesToAdds,
      ...entries.slice(0, entries.length - entriesToAdds.length),
    ],
    min: Math.min(min, ...entriesToAdds),
    max: Math.max(max, ...entriesToAdds),
    average: updatedTotal / updatedNbOfEntries,
    total: updatedTotal,
    nbOfEntries: updatedNbOfEntries,
    ...newExtras,
  };
};


const presice = (n) => Number.parseFloat(n).toFixed(2);
const formatOutput = (...args) => args.reduce((t, arg) => `${t}\n${arg}`);
const formatTitle = (title) => title;
const formatAggregates = ({ min, max, average }, unit) => ` MIN: ${presice(min)}${unit}   MAX: ${presice(max)}${unit}   AVERAGE: ${presice(
  average,
)}${unit} `;

let frames = { ...getInitialInfos(), jankyFrames: 0 };
let memory = getInitialInfos();
let cpu = getInitialInfos();

const getPid = async (deviceId, packageName) => {
  const output = await client
    .shell(deviceId, `pidof ${packageName}`)
    .then(adb.util.readAll);
  if (!output.toString('utf-8')) {
    await sleep(200);
    return getPid(deviceId, packageName);
  }
  console.log(chalk.green('App started.'));
  return parseInt(output, 10);
};

const getFramesInfos = async (deviceId, packageName) => {
  const output = await client
    .shell(deviceId, `dumpsys gfxinfo ${packageName} framestats reset`)
    .then(adb.util.readAll);
  const profiledata = RegExp(
    '(?<=---PROFILEDATA---\n)(.|\n)*?(?=---PROFILEDATA---)',
    'g',
  ).exec(output.toString('utf-8'));
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
  const jankyFrames = renderTimings.reduce((acc, timing) => (timing > 16.67 ? acc + 1 : acc), 0);
  frames = updateInfos(frames, renderTimings, { jankyFrames });
};

const getSysInfos = async (deviceId, pid) => {
  const output = await client
    .shell(deviceId, `top -b -n 1 -p ${pid} | tail -n 1`)
    .then(adb.util.readAll);
  const profiledata = output
    .toString('utf-8')
    .replace(/\s\s+/g, ' ')
    .split(' ').filter((data) => data !== '');
  memory = updateInfos(memory, [parseInt(profiledata[6], 10)]);
  cpu = updateInfos(cpu, [parseInt(profiledata[8], 10)]);
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

const draw = async (deviceId, packageName, pid) => {
  setInterval(() => {
    try {
      getFramesInfos(deviceId, packageName);
      getSysInfos(deviceId, pid);
      logUpdate(
        formatOutput(
          chalk.inverse.magenta(formatTitle(' FRAMES (frame timing - ms)')),
          chalk.magenta(
            asciichart.plot(
              [
                frames.entries,
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
          chalk.inverse.magenta(formatAggregates(frames, 'ms')),
          chalk.magenta(`Frames rendered: ${frames.nbOfEntries}`),
          chalk.magenta(`Janky frames': ${frames.jankyFrames} (${presice((frames.jankyFrames * 100) / frames.nbOfEntries)}%)`),
          ' ',
          chalk.inverse.blue(formatTitle(' MEMORY (use - MB)')),
          chalk.blue(
            asciichart.plot([memory.entries, [0, 0], [10, 10]], {
              height: 10,
            }),
          ),
          chalk.inverse.blue(formatAggregates(memory, 'MB')),
          ' ',
          chalk.inverse.cyan(formatTitle(' CPU (use - %thread)')),
          chalk.cyan(
            asciichart.plot([cpu.entries, [0, 0], [10, 10]], {
              height: 10,
            }),
          ),
          chalk.inverse.cyan(formatAggregates(cpu, '%')),
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
  const packageName = await askForPackageName(deviceId);
  console.log(`Waiting for ${packageName} to start...`);
  const pid = await getPid(deviceId, packageName);
  draw(deviceId, packageName, pid);
})();
