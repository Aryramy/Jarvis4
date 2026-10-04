/**
 * Minimal reusable logger for JARVIS4.
 * Supports DEBUG, INFO, WARN, ERROR levels.
 */

export const LogLevel = Object.freeze({
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
});

const LEVEL_NAMES = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR'
};

const NAME_TO_LEVEL = {
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  warning: LogLevel.WARN,
  error: LogLevel.ERROR
};

export class Logger {
  /**
   * @param {Object} [options]
   * @param {string} [options.name='app'] - Name/namespace for this logger
   * @param {number|string} [options.level=LogLevel.INFO] - Minimum log level
   * @param {Object} [options.destination=console] - Output target for log calls
   */
  constructor(options = {}) {
    this.name = options.name || 'app';
    this.level = this._parseLevel(options.level ?? process.env.LOG_LEVEL ?? LogLevel.INFO);
    this.destination = options.destination || console;
  }

  _parseLevel(level) {
    if (typeof level === 'number' && level >= LogLevel.DEBUG && level <= LogLevel.ERROR) {
      return level;
    }
    if (typeof level === 'string') {
      const normalized = level.toLowerCase().trim();
      if (normalized in NAME_TO_LEVEL) {
        return NAME_TO_LEVEL[normalized];
      }
    }
    return LogLevel.INFO;
  }

  setLevel(level) {
    this.level = this._parseLevel(level);
  }

  _format(level, message, meta) {
    const timestamp = new Date().toISOString();
    const levelStr = LEVEL_NAMES[level] || 'UNKNOWN';
    const prefix = `[${timestamp}] [${levelStr}] [${this.name}]`;
    if (meta !== undefined) {
      return `${prefix}: ${message} ${typeof meta === 'object' ? JSON.stringify(meta) : meta}`;
    }
    return `${prefix}: ${message}`;
  }

  _log(level, message, meta) {
    if (level < this.level) {
      return null;
    }
    const formatted = this._format(level, message, meta);
    switch (level) {
      case LogLevel.DEBUG:
        if (typeof this.destination.debug === 'function') {
          this.destination.debug(formatted);
        } else {
          this.destination.log(formatted);
        }
        break;
      case LogLevel.INFO:
        if (typeof this.destination.info === 'function') {
          this.destination.info(formatted);
        } else {
          this.destination.log(formatted);
        }
        break;
      case LogLevel.WARN:
        if (typeof this.destination.warn === 'function') {
          this.destination.warn(formatted);
        } else {
          this.destination.log(formatted);
        }
        break;
      case LogLevel.ERROR:
        if (typeof this.destination.error === 'function') {
          this.destination.error(formatted);
        } else {
          this.destination.log(formatted);
        }
        break;
      default:
        this.destination.log(formatted);
    }
    return formatted;
  }

  debug(message, meta) {
    return this._log(LogLevel.DEBUG, message, meta);
  }

  info(message, meta) {
    return this._log(LogLevel.INFO, message, meta);
  }

  warn(message, meta) {
    return this._log(LogLevel.WARN, message, meta);
  }

  error(message, meta) {
    return this._log(LogLevel.ERROR, message, meta);
  }

  child(subName) {
    return new Logger({
      name: `${this.name}:${subName}`,
      level: this.level,
      destination: this.destination
    });
  }
}

export const logger = new Logger({ name: 'jarvis4' });

export function createLogger(name, options = {}) {
  return new Logger({ name, ...options });
}

export default logger;
