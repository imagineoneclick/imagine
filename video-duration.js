const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const probePath = require('ffprobe-static').path;
const run = promisify(execFile);

function normalizeDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 2 || seconds > 15) {
    throw new Error('Reference video must be between 2 and 15 seconds.');
  }
  return Math.ceil(seconds);
}

async function referenceDuration(file) {
  if (!file || !file.buffer || file.buffer.length > 100 * 1024 * 1024) {
    throw new Error('Add a reference video under 100 MB.');
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'imagine-video-'));
  try {
    const input = path.join(dir, 'reference');
    await fs.writeFile(input, file.buffer);
    const { stdout } = await run(probePath, [
      '-v', 'error', '-protocol_whitelist', 'file',
      '-show_entries', 'format=format_name,duration:stream=codec_type,duration',
      '-of', 'json', input,
    ], { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true });
    const result = JSON.parse(stdout);
    if (!result.format?.format_name?.split(',').some(n => n === 'mov' || n === 'mp4') ||
        !result.streams?.some(s => s.codec_type === 'video')) {
      throw new Error('Use an MP4 or MOV video.');
    }
    const seconds = Math.max(Number(result.format.duration),
      ...result.streams.map(s => Number(s.duration)).filter(Number.isFinite));
    return { seconds, duration: normalizeDuration(seconds) };
  } catch (error) {
    if (error.message === 'Reference video must be between 2 and 15 seconds.' ||
        error.message === 'Use an MP4 or MOV video.') throw error;
    throw new Error('Could not read the reference video. Try another MP4 or MOV.');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { referenceDuration, normalizeDuration };
