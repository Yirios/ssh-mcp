import { describe, expect, it } from 'vitest';
import { parseMaxFileSize, SSHConnectionManager, validateRemotePath } from '../src/index';

describe('SFTP helpers', () => {
  describe('validateRemotePath', () => {
    it('accepts absolute paths and trims whitespace', () => {
      expect(validateRemotePath(' /tmp/example.txt ')).toBe('/tmp/example.txt');
    });

    it('rejects empty paths', () => {
      expect(() => validateRemotePath('')).toThrow('remotePath must be a non-empty string');
      expect(() => validateRemotePath('   ')).toThrow('remotePath must be a non-empty string');
    });

    it('rejects relative paths', () => {
      expect(() => validateRemotePath('tmp/example.txt')).toThrow('remotePath must be an absolute path');
    });

    it('rejects null bytes', () => {
      expect(() => validateRemotePath('/tmp/example\0.txt')).toThrow('remotePath cannot contain null bytes');
    });
  });

  describe('parseMaxFileSize', () => {
    it('uses the default for missing or invalid values', () => {
      expect(parseMaxFileSize(undefined)).toBe(10 * 1024 * 1024);
      expect(parseMaxFileSize(null)).toBe(10 * 1024 * 1024);
      expect(parseMaxFileSize('invalid')).toBe(10 * 1024 * 1024);
    });

    it('parses positive byte limits', () => {
      expect(parseMaxFileSize('4096')).toBe(4096);
    });

    it('supports no-limit mode', () => {
      expect(parseMaxFileSize('none')).toBe(Infinity);
      expect(parseMaxFileSize('0')).toBe(Infinity);
      expect(parseMaxFileSize('-1')).toBe(Infinity);
    });
  });

  describe('SSHConnectionManager.getSftp', () => {
    it('throws when called before connecting', () => {
      const manager = new SSHConnectionManager({
        host: '127.0.0.1',
        port: 22,
        username: 'test',
        password: 'secret',
      });

      expect(() => manager.getSftp()).toThrow('SSH connection not established');
    });
  });
});
