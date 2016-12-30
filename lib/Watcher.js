// @flow

import fbWatchman from 'fb-watchman';
import loglevel from 'loglevel';
import minimatch from 'minimatch';

import findAllFiles from './findAllFiles';
import normalizePath from './normalizePath';

const SUBSCRIPTION_NAME = 'import-js-subscription';

export default class Watcher {
  workingDirectory: string;
  listeners: Set<object>;
  excludes: Array<string>;
  onFilesAdded: Function;
  onFilesRemoved: Function;

  constructor({
    workingDirectory = process.cwd(),
    excludes = [],
    onFilesAdded = (): Promise<void> => Promise.resolve(),
    onFilesRemoved = (): Promise<void> => Promise.resolve(),
  }: Object) {
    this.workingDirectory = workingDirectory;
    this.excludes = excludes;
    this.onFilesAdded = onFilesAdded;
    this.onFilesRemoved = onFilesRemoved;
  }

  subscribe({
    client,
    fbWatch,
    relativePath,
  }: {
    client: fbWatchman.Client,
    fbWatch: string,
    relativePath: string,
  }): Promise<void> {
    const subscription = {
      // Match javascript files
      expression: [
        'anyof',
        ['suffix', 'js'],
        ['suffix', 'jsx'],
        ['suffix', 'json'],
      ],
      fields: ['name', 'exists', 'mtime_ms'],
      relative_root: relativePath,
    };

    return new Promise((resolve: Function, reject: Function) => {
      client.command(['subscribe', fbWatch, SUBSCRIPTION_NAME, subscription],
        (error: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });

      client.on('subscription', (resp: Object) => {
        if (resp.subscription !== SUBSCRIPTION_NAME) {
          return;
        }

        const added = [];
        const removed = [];
        resp.files.forEach((file: Object) => {
          const normalizedPath = normalizePath(file.name, this.workingDirectory);
          if (normalizedPath.startsWith('./node_modules/')) {
            return;
          }
          if (this.excludes.some((pattern: string): boolean =>
            minimatch(normalizedPath, pattern))) {
            return;
          }
          if (file.exists) {
            added.push({ path: normalizedPath, mtime: +file.mtime_ms });
          } else {
            removed.push({ path: normalizedPath });
          }
        });
        if (added.length) {
          this.onFilesAdded(added);
        }
        if (removed.length) {
          this.onFilesRemoved(removed);
        }
      });
    });
  }

  startSubscription({ client }: { client: fbWatchman.Client }): Promise<void> {
    return new Promise((resolve: Function, reject: Function) => {
      client.command(['watch-project', this.workingDirectory], (error: Error, resp: Object) => {
        if (error) {
          reject(error);
          return;
        }

        if ('warning' in resp) {
          loglevel.warn(`WARNING received during watchman init: ${resp.warning}`);
        }

        this.subscribe({
          client,
          fbWatch: resp.watch,
          relativePath: resp.relativePath,
        }).then(resolve).catch(reject);
      });
    });
  }

  initialize(): Promise<void> {
    return new Promise((resolve: Function, reject: Function) => {
      this.initializeWatchman().then(resolve).catch(() => {
        loglevel.info(
          "Couldn't initialize watchman watcher. Falling back to polling.");
        this.initializePolling().then(resolve).catch(reject);
      });
    });
  }

  /**
   * Get all files from the watchman-powered cache. Returns a promise that will
   * resolve if watchman is available, and the file cache is enabled. Will
   * resolve immediately if previously initialized.
   */
  initializeWatchman(): Promise<void> {
    return new Promise((resolve: Function, reject: Function) => {
      const client = new fbWatchman.Client();
      client.on('error', (error: Error) => {
        reject(error);
      });
      client.capabilityCheck({
        optional: [],
        required: ['relative_root'],
      }, (error: Error) => {
        if (error) {
          client.end();
          reject(error);
        } else {
          this.startSubscription({ client }).then(resolve).catch(reject);
        }
      });
    });
  }

  initializePolling() : Promise<void> {
    setInterval(() => {
      this.poll();
    }, 30000);
    return this.poll();
  }

  poll(): Promise<void> {
    return new Promise((resolve: Function, reject: Function) => {
      findAllFiles(this.workingDirectory, this.excludes)
        .then((files: Array<Object>) => {
          const mtimes = {};
          files.forEach(({ path: pathToFile, mtime }: Object) => {
            mtimes[pathToFile] = mtime;
          });
          this.storage.allFiles().then((storedFiles: Array<Object>) => {
            const removedFiles = [];
            storedFiles.forEach((storedFile: Object) => {
              const mtime = mtimes[storedFile];
              if (!mtime) {
                removedFiles.push({ path: storedFile });
              }
            });
            this.onFilesAdded(files)
              .then((): Promise<void> => this.onFilesRemoved(removedFiles))
              .then(resolve)
              .catch(reject);
          });
        }).catch(reject);
    });
  }
}