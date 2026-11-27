const fs = require('fs');
const path = require('path');

const MAX_FILES = 10;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB per log file
const BASE_LOG_DIR = process.platform === 'win32' ? 'C:\\homefood' : '/tmp/homefood';

class RingFileLogger {
  constructor(subFolder) {
    this.dir = path.join(BASE_LOG_DIR, subFolder);
    this.stateFile = path.join(this.dir, '.log_state.json');
    this.currentIndex = 1;
    this.init();
  }

  init() {
    try {
      if (!fs.existsSync(this.dir)) {
        fs.mkdirSync(this.dir, { recursive: true });
      }

      // Restore last active log index if available
      if (fs.existsSync(this.stateFile)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
          if (parsed.currentIndex >= 1 && parsed.currentIndex <= MAX_FILES) {
            this.currentIndex = parsed.currentIndex;
          }
        } catch (e) {
          this.currentIndex = 1;
        }
      }

      const activePath = this.getFilePath(this.currentIndex);
      if (!fs.existsSync(activePath)) {
        fs.writeFileSync(activePath, '', 'utf8');
      }
      this.saveState();
    } catch (e) {
      // Ignore logger init failures on restricted filesystems
    }
  }

  getFilePath(index) {
    return path.join(this.dir, `log${index}.log`);
  }

  saveState() {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({ currentIndex: this.currentIndex }), 'utf8');
    } catch (e) {
      // Ignore state write failures
    }
  }

  rotateNext() {
    this.currentIndex = this.currentIndex >= MAX_FILES ? 1 : this.currentIndex + 1;
    const nextPath = this.getFilePath(this.currentIndex);

    // Delete existing file at next slot and recreate fresh
    if (fs.existsSync(nextPath)) {
      fs.unlinkSync(nextPath);
    }
    fs.writeFileSync(nextPath, '', 'utf8');
    this.saveState();
    return nextPath;
  }

  write(level, event, details = {}) {
    try {
      const timestamp = new Date().toISOString();
      const detailStr = Object.keys(details).length > 0 ? ` | ${JSON.stringify(details)}` : '';
      const line = `[${timestamp}] [${level}] [${event}]${detailStr}\n`;
      const lineBytes = Buffer.byteLength(line, 'utf8');

      let filePath = this.getFilePath(this.currentIndex);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '', 'utf8');
      }

      const stats = fs.statSync(filePath);
      if (stats.size + lineBytes > MAX_BYTES) {
        filePath = this.rotateNext();
      }

      fs.appendFileSync(filePath, line, 'utf8');
    } catch (err) {
      console.error(`[Logger Error - ${this.dir}]:`, err.message);
    }
  }
}

const serverLogger = new RingFileLogger('server');
const clientLogger = new RingFileLogger('client');

module.exports = {
  serverLogger,
  clientLogger,
  BASE_LOG_DIR,
  MAX_FILES,
  MAX_BYTES
};
