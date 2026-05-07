/** Tests for file-utils.ts - exclusion rules, workspace root, and path validation. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('file-utils', () => {
  let tmpDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    vi.resetModules();
    originalEnv = { ...process.env };
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-utils-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env = originalEnv;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('exclusion rules with FILE_BROWSER_ROOT', () => {
    describe('dynamic exclusion rules', () => {
      it('disables exclusions when FILE_BROWSER_ROOT is set', async () => {
        process.env.FILE_BROWSER_ROOT = '/custom/workspace';
        vi.resetModules();
        
        const { isExcluded } = await import('./file-utils.js');
        
        // When FILE_BROWSER_ROOT is set, exclusions are disabled
        expect(isExcluded('node_modules')).toBe(false);
        expect(isExcluded('.git')).toBe(false);
        expect(isExcluded('dist')).toBe(false);
      });

      it('enables exclusions when FILE_BROWSER_ROOT is not set', async () => {
        delete process.env.FILE_BROWSER_ROOT;
        vi.resetModules();
        
        const { isExcluded } = await import('./file-utils.js');
        
        // When FILE_BROWSER_ROOT is not set, exclusions are enabled
        expect(isExcluded('node_modules')).toBe(true);
        expect(isExcluded('.git')).toBe(true);
        expect(isExcluded('dist')).toBe(true);
        expect(isExcluded('src')).toBe(false);
        expect(isExcluded('README.md')).toBe(false);
      });

      it('handles empty string FILE_BROWSER_ROOT correctly', async () => {
        // Test that empty string behaves like unset (enables exclusions)
        process.env.FILE_BROWSER_ROOT = '';
        vi.resetModules();
        
        const { isExcluded } = await import('./file-utils.js');
        
        // Empty string should enable exclusions
        expect(isExcluded('node_modules')).toBe(true);
        expect(isExcluded('.git')).toBe(true);
        expect(isExcluded('src')).toBe(false);
      });
    });
  });

  describe('getWorkspaceRoot', () => {
    it('returns FILE_BROWSER_ROOT when set', async () => {
      process.env.FILE_BROWSER_ROOT = '/custom/root/path';
      vi.resetModules();
      
      const { getWorkspaceRoot } = await import('./file-utils.js');
      expect(getWorkspaceRoot()).toBe(path.resolve('/custom/root/path'));
    });

    it('returns parent of MEMORY.md when FILE_BROWSER_ROOT is not set', async () => {
      delete process.env.FILE_BROWSER_ROOT;
      vi.resetModules();
      
      const { getWorkspaceRoot } = await import('./file-utils.js');
      const result = getWorkspaceRoot();
      // Should return parent of default memory path
      expect(result).toContain('.openclaw');
      expect(result).toContain('workspace');
    });

    it('returns parent of MEMORY.md when FILE_BROWSER_ROOT is empty string', async () => {
      process.env.FILE_BROWSER_ROOT = '';
      vi.resetModules();
      
      const { getWorkspaceRoot } = await import('./file-utils.js');
      const result = getWorkspaceRoot();
      // Should return parent of default memory path
      expect(result).toContain('.openclaw');
      expect(result).toContain('workspace');
    });
  });

  describe('resolveWorkspacePath with filesystem root custom workspace', () => {
    it('allows resolving child paths when root is "/" (or drive root)', async () => {
      const fsRoot = path.parse(os.tmpdir()).root;
      process.env.FILE_BROWSER_ROOT = fsRoot;
      vi.resetModules();

      const { resolveWorkspacePath } = await import('./file-utils.js');
      const relTmpDir = path.relative(fsRoot, os.tmpdir());
      const candidate = path.join(relTmpDir, 'non-existent.txt');

      const resolved = await resolveWorkspacePath(candidate, { allowNonExistent: true });
      expect(resolved).toBe(path.resolve(fsRoot, candidate));
    });

    it('normalizes symlinked workspace roots before validating children', async () => {
      const realRoot = await fs.mkdtemp(path.join(tmpDir, 'workspace-real-'));
      const aliasRoot = path.join(tmpDir, 'workspace-alias');
      await fs.symlink(realRoot, aliasRoot);
      await fs.mkdir(path.join(realRoot, 'docs'), { recursive: true });
      await fs.writeFile(path.join(realRoot, 'docs', 'note.md'), '# note');

      process.env.FILE_BROWSER_ROOT = aliasRoot;
      vi.resetModules();

      const { resolveWorkspacePathForRoot } = await import('./file-utils.js');
      const resolved = await resolveWorkspacePathForRoot(aliasRoot, 'docs/note.md');

      expect(resolved).toBe(await fs.realpath(path.join(realRoot, 'docs', 'note.md')));
    });
  });

  describe('isBinary', () => {
    it('identifies common binary file extensions', async () => {
      const { isBinary } = await import('./file-utils.js');
      
      // Images
      expect(isBinary('image.png')).toBe(true);
      expect(isBinary('photo.jpg')).toBe(true);
      expect(isBinary('graphic.jpeg')).toBe(true);
      expect(isBinary('animation.gif')).toBe(true);
      expect(isBinary('modern.webp')).toBe(true);
      expect(isBinary('vector.svg')).toBe(true);
      expect(isBinary('icon.ico')).toBe(true);
      
      // Audio/Video
      expect(isBinary('music.mp3')).toBe(true);
      expect(isBinary('video.mp4')).toBe(true);
      expect(isBinary('audio.wav')).toBe(true);
      expect(isBinary('sound.ogg')).toBe(true);
      expect(isBinary('lossless.flac')).toBe(true);
      expect(isBinary('web-video.webm')).toBe(true);
      
      // Archives
      expect(isBinary('archive.zip')).toBe(true);
      expect(isBinary('source.tar')).toBe(true);
      expect(isBinary('compressed.gz')).toBe(true);
      expect(isBinary('archive.bz2')).toBe(true);
      expect(isBinary('packed.7z')).toBe(true);
      expect(isBinary('archive.rar')).toBe(true);
      
      // Documents
      expect(isBinary('document.pdf')).toBe(true);
      expect(isBinary('office.doc')).toBe(true);
      expect(isBinary('spreadsheet.xls')).toBe(true);
      expect(isBinary('presentation.docx')).toBe(true);
      expect(isBinary('data.xlsx')).toBe(true);
      
      // Executables and libraries
      expect(isBinary('program.exe')).toBe(true);
      expect(isBinary('library.dll')).toBe(true);
      expect(isBinary('shared.so')).toBe(true);
      expect(isBinary('mac-library.dylib')).toBe(true);
      
      // Fonts
      expect(isBinary('font.woff')).toBe(true);
      expect(isBinary('font.woff2')).toBe(true);
      expect(isBinary('font.ttf')).toBe(true);
      expect(isBinary('font.eot')).toBe(true);
      
      // Databases
      expect(isBinary('database.sqlite')).toBe(true);
      expect(isBinary('data.db')).toBe(true);
    });

    it('identifies text files as non-binary', async () => {
      const { isBinary } = await import('./file-utils.js');
      
      expect(isBinary('script.js')).toBe(false);
      expect(isBinary('style.css')).toBe(false);
      expect(isBinary('page.html')).toBe(false);
      expect(isBinary('data.json')).toBe(false);
      expect(isBinary('config.xml')).toBe(false);
      expect(isBinary('document.md')).toBe(false);
      expect(isBinary('readme.txt')).toBe(false);
      expect(isBinary('script.py')).toBe(false);
      expect(isBinary('script.ts')).toBe(false);
      expect(isBinary('component.jsx')).toBe(false);
    });

    it('handles case insensitive extensions', async () => {
      const { isBinary } = await import('./file-utils.js');
      
      expect(isBinary('IMAGE.PNG')).toBe(true);
      expect(isBinary('Music.MP3')).toBe(true);
      expect(isBinary('Document.PDF')).toBe(true);
      expect(isBinary('Script.JS')).toBe(false);
      expect(isBinary('Style.CSS')).toBe(false);
    });

    it('handles files without extensions', async () => {
      const { isBinary } = await import('./file-utils.js');
      
      expect(isBinary('Makefile')).toBe(false);
      expect(isBinary('README')).toBe(false);
      expect(isBinary('executable')).toBe(false);
    });

    it('handles files with multiple dots', async () => {
      const { isBinary } = await import('./file-utils.js');
      
      expect(isBinary('app.config.json')).toBe(false);
      expect(isBinary('bundle.min.js')).toBe(false);
      expect(isBinary('photo.thumbnail.jpg')).toBe(true);
      expect(isBinary('archive.v1.tar.gz')).toBe(true);
    });
  });

  describe('MAX_FILE_SIZE constant', () => {
    it('exports the correct file size limit', async () => {
      const { MAX_FILE_SIZE } = await import('./file-utils.js');
      expect(MAX_FILE_SIZE).toBe(1_048_576); // 1 MB
    });
  });
});
