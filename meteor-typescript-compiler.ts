import * as ts from "typescript";
import * as crypto from "crypto";
import { bold, dim, reset } from "chalk";
import { emitWarning } from "process";

/**
 * compiler-console (could not figure out how to load from separate file/module)
 * only got errors of type "packages/modules-runtime.js:222:12: Cannot find module 'compiler-console'"
 */

let traceEnabled = false;

export function setTraceEnabled(enabled: boolean) {
  traceEnabled = enabled;
}

export function error(msg: string, ...other: string[]) {
  process.stderr.write(bold.red(msg) + reset(other.join(" ")) + "\n");
}

export function warn(msg: string, ...other: string[]) {
  process.stderr.write(bold.yellow(msg) + reset(other.join(" ")) + "\n");
}

export function info(msg: string) {
  process.stdout.write(bold.green(msg) + dim(" ") + "\n");
}

export function trace(msg: string) {
  if (traceEnabled) {
    process.stdout.write(dim(msg) + dim(" ") + "\n");
  }
}

/**
 * compiler-cache (could not figure out how to load from separate file/module)
 */
interface JavascriptData {
  source: string;
  fileName: string;
}

interface CacheData {
  javascript: JavascriptData;
  sourceMapJson: string | undefined;
}

interface JsCacheContent {
  type: "js";
  content: JavascriptData;
}
interface SourceMapCacheContent {
  type: "sourceMap";
  content: string;
}
type CacheContent = JsCacheContent | SourceMapCacheContent;

interface CacheContainer {
  sourceFilePath: string;
  content: CacheContent;
}

function tryParse<T>(s: string): T | undefined {
  try {
    return JSON.parse(s);
  } catch (e) {
    error(`${e.message} when parsing ${s}`);
  }
  return undefined;
}

/**
 * Caches output from typescript on disk
 */
export class CompilerCache {
  constructor(private cacheRoot: string) {}

  private getKey(sourceFilePath: string) {
    const result = calculateHash(sourceFilePath);
    return result;
  }

  private getHashContentPath(sourceFilePath: string, type: "js" | "sourceMap") {
    const key = this.getKey(sourceFilePath);
    const result = `${this.cacheRoot}/${type}/${key}.json`;
    return result;
  }

  private writeContent(sourceFilePath: string, content: CacheContent) {
    const path = this.getHashContentPath(sourceFilePath, content.type);
    const container: CacheContainer = {
      sourceFilePath,
      content,
    };
    const data = JSON.stringify(container);
    ts.sys.writeFile(path, data);
  }

  private readContent(
    sourceFilePath: string,
    type: "js" | "sourceMap"
  ): CacheContent | undefined {
    const path = this.getHashContentPath(sourceFilePath, type);
    if (ts.sys.fileExists(path)) {
      const fileContents = ts.sys.readFile(path);
      const container = fileContents
        ? tryParse<CacheContainer>(fileContents)
        : undefined;
      return container?.content;
    }
    return undefined;
  }

  public addJavascript(sourceFilePath: string, data: JavascriptData) {
    this.writeContent(sourceFilePath, { type: "js", content: data });
  }
  public addSourceMap(sourceFilePath: string, data: string) {
    this.writeContent(sourceFilePath, { type: "sourceMap", content: data });
  }
  public get(sourceFilePath: string): CacheData | undefined {
    const jsData = this.getJavascript(sourceFilePath);
    if (!jsData) {
      return undefined;
    }
    const sourceMapJson = this.getSourceMap(sourceFilePath);
    return { javascript: jsData, sourceMapJson };
  }
  private getJavascript(sourceFilePath: string): JavascriptData | undefined {
    const content = this.readContent(sourceFilePath, "js");
    if (content?.type === "js") {
      return content.content;
    }
  }
  private getSourceMap(sourceFilePath: string): string | undefined {
    const content = this.readContent(sourceFilePath, "sourceMap");
    if (content?.type === "sourceMap") {
      return content.content;
    }
    return undefined;
  }
}

interface LocalEmitResult {
  fileName: string;
  data: string;
  sourceMap?: MeteorCompiler.SourceMap;
}

function isBare(inputFile: MeteorCompiler.InputFile): boolean {
  const fileOptions = inputFile.getFileOptions();
  return !!fileOptions?.bare;
}

function calculateHash(source: string): string {
  return crypto.createHash("SHA1").update(source).digest("hex");
}

function getRelativeFileName(filename: string): string {
  const curDir = ts.sys.getCurrentDirectory();
  if (filename.startsWith(curDir)) {
    return filename.substring(curDir.length + 1);
  }
  return filename;
}

type BuilderProgramType = ts.SemanticDiagnosticsBuilderProgram;

type BuilderProgramOptions = Readonly<{
  program: BuilderProgramType;
  /**
   * Path to buildinfo file
   */
  buildInfoFile: string;
}>;

type WatcherInstance = Readonly<{
  watch: ts.Watch<BuilderProgramType>;
  /**
   * Path to buildinfo file
   */
  buildInfoFile: string;
}>;

export class MeteorTypescriptCompilerImpl extends BabelCompiler {
  private cachedWatchers: Map<string, WatcherInstance> = new Map();
  private numEmittedFiles = 0;
  private numStoredFiles = 0;
  private numCompiledFiles = 0;
  private numFilesFromCache = 0;
  private numFilesToCache = 0;

  /**
   * Used to inject the source map into the babel compilation
   * through the inferExtraBabelOptions override
   */
  private withSourceMap:
    | { sourceMap: MeteorCompiler.SourceMap; pathInPackage: string }
    | undefined = undefined;

  private cache: CompilerCache | undefined = undefined;

  private cacheRoot = ".meteor/local/.typescript-incremental";

  constructor() {
    super({});
    setTraceEnabled(!!process.env.METEOR_TYPESCRIPT_TRACE_ENABLED);
  }

  reportWatchStatus(
    diagnostic: ts.Diagnostic,
    newLine: string,
    options: ts.CompilerOptions,
    errorCount?: number
  ) {
    this.writeDiagnostics([diagnostic]);
  }

  prepareIncrementalProgram(
    program: BuilderProgramType,
    buildInfoFile: string
  ) {
    const diagnostics = [
      ...program.getConfigFileParsingDiagnostics(),
      ...program.getSyntacticDiagnostics(),
      ...program.getOptionsDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSemanticDiagnostics(), // Get the diagnostics before emit to cache them in the buildInfo file.
    ];

    const writeIfBuildInfo = (
      fileName: string,
      data: string,
      writeByteOrderMark: boolean | undefined
    ): boolean => {
      if (fileName === buildInfoFile) {
        info(`Writing ${getRelativeFileName(buildInfoFile)}`);
        ts.sys.writeFile(fileName, data, writeByteOrderMark);
        return true;
      }
      return false;
    };

    /**
     * "emit" without a sourcefile will process all changed files, including the buildinfo file
     * so we need to write it out if it changed.
     * Then we can also tell which files were recompiled and put the data into the cache.
     */
    const emitResult = program.emit(
      undefined,
      (fileName, data, writeByteOrderMark, onError, sourceFiles) => {
        if (!writeIfBuildInfo(fileName, data, writeByteOrderMark)) {
          if (sourceFiles && sourceFiles.length > 0) {
            const relativeSourceFilePath = getRelativeFileName(
              sourceFiles[0].fileName
            );
            if (fileName.match(/\.js$/)) {
              info(`Compiling ${relativeSourceFilePath}`);
              this.numCompiledFiles++;
              this.addJavascriptToCache(relativeSourceFilePath, {
                fileName,
                source: data,
              });
            }
            if (fileName.match(/\.map$/)) {
              this.cache?.addSourceMap(relativeSourceFilePath, data);
            }
          }
        }
      }
    );

    this.writeDiagnostics(diagnostics);
  }

  createWatcher(directory: string): WatcherInstance {
    info(`Creating new Typescript watcher for ${directory}`);

    const configPath = ts.findConfigFile(
      /*searchPath*/ "./",
      ts.sys.fileExists,
      "tsconfig.json"
    );
    if (!configPath) {
      throw new Error("Could not find a valid 'tsconfig.json'.");
    }

    const buildInfoFile = ts.sys.resolvePath(
      `${this.cacheRoot}/buildfile.tsbuildinfo`
    );
    if (!process.env.METEOR_TYPESCRIPT_CACHE_DISABLED) {
      this.cache = new CompilerCache(
        ts.sys.resolvePath(`${this.cacheRoot}/v1cache`)
      );
    }
    const optionsToExtend: ts.CompilerOptions = {
      incremental: true,
      tsBuildInfoFile: buildInfoFile,
      noEmit: false,
      sourceMap: true,
    };

    // const config = ts.getParsedCommandLineOfConfigFile(
    //   configPath,
    //   optionsToExtend,
    //   /*host*/ {
    //     ...ts.sys,
    //     onUnRecoverableConfigFileDiagnostic: (d) =>
    //       error(ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    //   }
    // );
    // if (!config) {
    //   throw new Error("Could not parse 'tsconfig.json'.");
    // }

    // config.fileNames = this.filterSourceFilenames(config.fileNames);

    // // Too much information to handle for large projects…
    // // trace("config.fileNames:\n" + config.fileNames.join("\n"));

    // const program = ts.createIncrementalProgram({
    //   rootNames: config.fileNames,
    //   options: config.options,
    //   configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(config),
    //   projectReferences: config.projectReferences,
    //   // createProgram can be passed in here to choose strategy for incremental compiler just like when creating incremental watcher program.
    //   // Default is ts.createSemanticDiagnosticsBuilderProgram
    // });

    const createProgram: ts.CreateProgram<BuilderProgramType> = (
      rootNames = [],
      options = {},
      host,
      oldProgram,
      configFileParsingDiagnostics,
      projectReferences
    ) => {
      // info(
      //   `buildinfo file: ${getRelativeFileName(
      //     options.tsBuildInfoFile ?? "no buildinfo file"
      //   )}`
      // );
      const hostWithIncremental: ts.CompilerHost = {
        ...(host ?? {}),
        ...ts.createIncrementalCompilerHost(options),
      };
      const program = ts.createIncrementalProgram({
        rootNames,
        options,
        configFileParsingDiagnostics,
        projectReferences,
        //        host: hostWithIncremental,
        //        createProgram: ts.createEmitAndSemanticDiagnosticsBuilderProgram,
      });
      return program;
    };
    const watchOptionsToExtend: ts.WatchOptions = {};
    const watchHost = ts.createWatchCompilerHost(
      configPath,
      optionsToExtend,
      ts.sys,
      createProgram,
      (diagnostic) => this.writeDiagnostics([diagnostic]),
      (...args) => this.reportWatchStatus(...args),
      watchOptionsToExtend
    );
    watchHost.afterProgramCreate = (program) => {
      // The default implementation is to emit files to disk, which we absolutely do not want
      this.prepareIncrementalProgram(program, buildInfoFile);
    };

    const watch = ts.createWatchProgram(watchHost);
    return { buildInfoFile, watch };
  }

  getBuilderProgramForCurrentDirectory() {
    return this.getBuilderProgram(ts.sys.getCurrentDirectory());
  }

  programFromWatcher({
    watch,
    buildInfoFile,
  }: WatcherInstance): BuilderProgramOptions {
    return {
      program: watch.getProgram(),
      buildInfoFile,
    };
  }

  /**
   * Gets from cache or creates a new program
   */
  getBuilderProgram(directory: string): BuilderProgramOptions {
    const foundInCache = this.cachedWatchers.get(directory);
    if (foundInCache) {
      return this.programFromWatcher(foundInCache);
    }
    const newEntry = this.createWatcher(directory);
    this.cachedWatchers.set(directory, newEntry);
    return this.programFromWatcher(newEntry);
  }

  /**
   * Invoked by the Meteor compiler framework
   */
  public setDiskCacheDirectory(path: string) {
    super.setDiskCacheDirectory(path);
    this.cacheRoot = path;
  }

  writeDiagnosticMessage(diagnostics: ts.Diagnostic, message: string) {
    switch (diagnostics.category) {
      case ts.DiagnosticCategory.Error:
        return error(message);
      case ts.DiagnosticCategory.Warning:
      case ts.DiagnosticCategory.Suggestion:
      case ts.DiagnosticCategory.Message:
        return info(message);
    }
  }

  writeDiagnostics(diagnostics: ts.Diagnostic[]) {
    diagnostics.forEach((diagnostic) => {
      if (diagnostic.file) {
        let { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
          diagnostic.start!
        );
        let message = ts.flattenDiagnosticMessageText(
          diagnostic.messageText,
          "\n"
        );
        this.writeDiagnosticMessage(
          diagnostic,
          `${getRelativeFileName(diagnostic.file.fileName)} (${line + 1},${
            character + 1
          }): ${message}`
        );
      } else {
        this.writeDiagnosticMessage(
          diagnostic,
          `${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`
        );
      }
    });
  }

  /**
   * TBD in order to not force all projects to repeat the Meteor filename inclusion rules in the tsconfig.json
   * exclude section, we should filter out files here:
   *    Files in directories named "tests"
   *    Files specified in .meteorignore files
   *    other Meteor rules
   *
   * An alternative would be to provide a custom version of getFilesInDir
   * to the host parameter of getParsedCommandLineOfConfigFile
   */
  filterSourceFilenames(sourceFiles: string[]): string[] {
    return sourceFiles;
  }

  startIncrementalCompilation() {
    const {
      program,
      buildInfoFile,
    } = this.getBuilderProgramForCurrentDirectory();

    return program;
  }

  /**
   * Adds if enabled
   */
  addJavascriptToCache(sourceFilePath: string, data: JavascriptData) {
    if (this.cache) {
      this.numFilesToCache++;
      this.cache.addJavascript(sourceFilePath, data);
    }
  }

  prepareSourceMap(
    sourceMapJson: string | undefined,
    inputFile: MeteorCompiler.InputFile,
    sourceFile: ts.SourceFile
  ): Object | undefined {
    if (!sourceMapJson) {
      return undefined;
    }
    const sourceMap: any = JSON.parse(sourceMapJson);
    sourceMap.sourcesContent = [sourceFile.text];
    sourceMap.sources = [inputFile.getPathInPackage()];
    return sourceMap;
  }

  emitForSource(
    inputFile: MeteorCompiler.InputFile,
    sourceFile: ts.SourceFile,
    program: BuilderProgramType
  ): LocalEmitResult | undefined {
    this.numEmittedFiles++;

    let emitResults: LocalEmitResult[] = [];
    let sourceMapJsonResults: string[] = [];

    trace(`Emitting Javascript for ${inputFile.getPathInPackage()}`);

    program.emit(sourceFile, function (fileName, data) {
      if (fileName.match(/\.map$/)) {
        sourceMapJsonResults.push(data);
      } else {
        emitResults.push({ data, fileName });
      }
    });
    if (emitResults.length === 0) {
      return undefined;
    }
    const result = emitResults.pop();
    const sourceMapJson = sourceMapJsonResults.pop();
    if (!result) {
      return;
    }
    const sourcePath = inputFile.getPathInPackage();
    this.cache?.addJavascript(sourcePath, {
      fileName: result.fileName,
      source: result.data,
    });
    const sourceMap = sourceMapJson
      ? this.prepareSourceMap(sourceMapJson, inputFile, sourceFile)
      : undefined;
    if (sourceMapJson) {
      this.cache?.addSourceMap(sourcePath, sourceMapJson);
    }
    return { ...result, sourceMap };
  }

  getOutputForSource(
    inputFile: MeteorCompiler.InputFile,
    sourceFile: ts.SourceFile,
    program: BuilderProgramType
  ): LocalEmitResult | undefined {
    const fromCache = this.cache?.get(inputFile.getPathInPackage());
    if (fromCache) {
      const {
        sourceMapJson,
        javascript: { fileName, source },
      } = fromCache;
      const sourceMap = this.prepareSourceMap(
        sourceMapJson,
        inputFile,
        sourceFile
      );
      this.numFilesFromCache++;
      return { data: source, sourceMap, fileName };
    }
    return this.emitForSource(inputFile, sourceFile, program);
  }

  public inferExtraBabelOptions(
    inputfile: MeteorCompiler.InputFile,
    babelOptions: any,
    cacheDeps: any
  ): boolean {
    if (
      this.withSourceMap &&
      inputfile.getPathInPackage() === this.withSourceMap.pathInPackage
    ) {
      // Ensure that the Babel compiler picks up our source maps
      babelOptions.inputSourceMap = this.withSourceMap.sourceMap;
    }
    return super.inferExtraBabelOptions(inputfile, babelOptions, cacheDeps);
  }

  emitResultFor(
    inputFile: MeteorCompiler.InputFile,
    program: BuilderProgramType
  ) {
    const inputFilePath = inputFile.getPathInPackage();
    const sourceFile =
      program.getSourceFile(inputFilePath) ||
      program.getSourceFile(ts.sys.resolvePath(inputFilePath));

    if (!sourceFile) {
      trace(`Could not find source file for ${inputFilePath}`);
      return;
    }
    try {
      const sourcePath = inputFile.getPathInPackage();
      const bare = isBare(inputFile);
      const hash = inputFile.getSourceHash();
      inputFile.addJavaScript({ path: sourcePath, bare, hash }, () => {
        this.numStoredFiles++;
        const emitResult = this.getOutputForSource(
          inputFile,
          sourceFile,
          program
        );
        if (!emitResult) {
          error(`Nothing emitted for ${inputFilePath}`);
          return {};
        }
        const { data, fileName, sourceMap } = emitResult;
        // To get Babel processing, we must invoke it ourselves via the
        // inherited BabelCompiler method processOneFileForTarget
        // To get the source map injected we override inferExtraBabelOptions
        if (sourceMap) {
          this.withSourceMap = {
            sourceMap,
            pathInPackage: inputFilePath,
          };
        }
        const jsData = this.processOneFileForTarget(inputFile, data);
        // Use the same hash as in the deferred data
        return {
          ...jsData,
          hash,
        };
      });
    } catch (e) {
      error(e.message);
    }
  }

  clearStats() {
    this.numEmittedFiles = 0;
    this.numFilesFromCache = 0;
    this.numFilesToCache = 0;
    this.numStoredFiles = 0;
    this.numCompiledFiles = 0;
  }

  // Called by the compiler plugins system after all linking and lazy
  // compilation has finished. (bundler.js)
  afterLink() {
    if (this.numStoredFiles) {
      const emitCacheInfo = this.cache
        ? `${this.numFilesToCache} updated emitted files stored in disk cache`
        : `${this.numEmittedFiles} files emitted`;
      info(
        `Typescript summary: ${emitCacheInfo}, ${this.numStoredFiles} transpiled files sent on for bundling`
      );
      if (this.cache && this.numEmittedFiles > 0) {
        warn(
          `${this.numEmittedFiles} files emitted ad-hoc (cache inconsistency)`
        );
      }
    }

    // Reset since this method gets called once for each resourceSlot
    this.clearStats();
  }

  processFilesForTarget(inputFiles: MeteorCompiler.InputFile[]) {
    if (inputFiles.length === 0) {
      return;
    }
    this.clearStats();

    const firstInput = inputFiles[0];
    const startTime = Date.now();
    info(
      `Typescript compilation for ${firstInput.getArch()} using Typescript ${
        ts.version
      }`
    );

    const program = this.startIncrementalCompilation();

    const isCompilableFile = (f: MeteorCompiler.InputFile) => {
      const fileName = f.getBasename();
      const dirName = f.getDirname();
      return (
        !fileName.endsWith(".d.ts") &&
        fileName !== "tsconfig.json" &&
        // we really don’t want to compile .ts files in node_modules but meteor will send them
        // anyway as input files. Adding node_modules to .meteorignore causes other runtime problems
        // so this is a somewhat ugly workaround
        !dirName.startsWith("node_modules/")
      );
    };
    const compilableFiles = inputFiles.filter(isCompilableFile);
    for (const inputFile of compilableFiles) {
      this.emitResultFor(inputFile, program);
    }
    const endTime = Date.now();
    const delta = endTime - startTime;
    info(
      `Compilation finished in ${Math.round(delta / 100) / 10} seconds. ${
        compilableFiles.length
      } input files, ${this.numCompiledFiles} files compiled`
    );
  }
}

// I haven’t figured out how to use a proper export here
MeteorTypescriptCompiler = MeteorTypescriptCompilerImpl;
