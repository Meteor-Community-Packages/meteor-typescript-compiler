import * as ts from "typescript";
import { bold, dim, reset } from "chalk";

/**
 * compiler-console (could not figure out how to load from separate file/module)
 * only got errors of type "packages/modules-runtime.js:222:12: Cannot find module 'compiler-console'"
 */

let traceEnabled = false;
function shouldFailOnErrors():boolean{
  const value = process.env.TYPESCRIPT_FAIL_ON_COMPILATION_ERRORS;
  if (!value) {
    return false;
  }
  // 0 and false => false too
  return !["0","false"].includes(value.toLowerCase());
}
const failOnErrors = shouldFailOnErrors()

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

function _getCallStack(depth: number): string {
  const parts = (new Error().stack ?? "").split("\n");
  return "\n" + parts.slice(2, depth + 2).join("\n");
}

/**
 * Returns rounded to seconds with one decimal
 */
function msToSec(milliseconds: number) {
  return Math.round(milliseconds / 100) / 10;
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



/**
 * Stores output from typescript on disk
 */
export class CompilerCache {
  constructor(public cachedFilesRoot: string) {}

  private getKey(sourceFilePath: string) {
    // Remove extension (.ts, .tsx)
    const parts = sourceFilePath.split(".");
    const result = parts.slice(0, parts.length - 1).join(".");
    return result;
  }

  private getContentPath(sourceFilePath: string, type: "js" | "sourceMap") {
    const key = this.getKey(sourceFilePath);
    const extension = type === "sourceMap" ? "js.map" : "js";
    const result = `${this.cachedFilesRoot}/${key}.${extension}`;
    return result;
  }

  private readContent(
    sourceFilePath: string,
    type: "js" | "sourceMap"
  ): CacheContent | undefined {
    const path = this.getContentPath(sourceFilePath, type);
    if (ts.sys.fileExists(path)) {
      const fileContents = ts.sys.readFile(path);
      if (!fileContents) {
        return undefined;
      }
      if (type === "js") {
        const filePath = this.getKey(sourceFilePath);
        const result: JsCacheContent = {
          type,
          content: {
            fileName: `${filePath}.js`,
            source: fileContents,
          },
        };
        return result;
      } else {
        return { type, content: fileContents };
      }
    }
    error(`did not find ${path}`);

    return undefined;
  }

  public writeEmittedFile(
    path: string,
    data: string,
    writeByteOrderMark: boolean
  ) {
    ts.sys.writeFile(path, data, writeByteOrderMark);
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

function getRelativeFileName(filename: string, sourceRoot: string): string {
  if (sourceRoot && filename.startsWith(sourceRoot)) {
    return filename.substring(sourceRoot.length + 1);
  }
  return filename;
}

function getDiagnosticMessage(diagnostic: ts.Diagnostic,sourceRoot:string|undefined): string {
  if (diagnostic.file && diagnostic.start !== undefined){
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
      diagnostic.start
    );
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      "\n"
    );
    return `${getRelativeFileName(
        diagnostic.file.fileName,
        sourceRoot ?? ""
      )} (${line + 1},${character + 1}): ${message}`    
  }
  return ts.flattenDiagnosticMessageText(diagnostic.messageText,ts.sys.newLine);
}


type BuilderProgramType = ts.EmitAndSemanticDiagnosticsBuilderProgram;

type BuilderProgramOptions = Readonly<{
  program: BuilderProgramType;
  /**
   * Path to buildinfo file
   */
  buildInfoFile: string;
}>;

type WatcherInstance = {
  readonly watch: ts.Watch<BuilderProgramType>;
  /**
   * Path to buildinfo file
   */
  readonly buildInfoFile: string;
  readonly cache: CompilerCache;
  readonly getLastDiagnostics: () => ReadonlyArray<ts.Diagnostic>;
};

export class MeteorTypescriptCompilerImpl extends BabelCompiler {
  private cachedWatchers: Map<string, WatcherInstance> = new Map();
  private numEmittedFiles = 0;
  private numStoredFiles = 0;
  private numCompiledFiles = 0;
  private numFilesFromCache = 0;
  private numFilesWritten = 0;
  private processStartTime = 0;

  /**
   * Used to inject the source map into the babel compilation
   * through the inferExtraBabelOptions override
   */
  private withSourceMap:
    | { sourceMap: MeteorCompiler.SourceMap; pathInPackage: string }
    | undefined = undefined;

  private cacheRoot = ".meteor/local/.typescript-incremental";

  constructor() {
    super({});
    setTraceEnabled(!!process.env.METEOR_TYPESCRIPT_TRACE_ENABLED);
  }

  reportWatchStatus(
    diagnostic: ts.Diagnostic,
    _newLine: string,
    _options: ts.CompilerOptions,
    _errorCount?: number
  ) {
    this.writeDiagnostics([diagnostic], undefined);
  }

  emitAllAffectedFiles(
    program: BuilderProgramType,
    cache: CompilerCache,
    buildInfoFile: string,
    sourceRoot: string
  ) {
    const startTime = Date.now();
    this.clearStats();

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
      writeByteOrderMark: boolean
    ): boolean => {
      if (fileName === buildInfoFile) {
        info(`Writing ${getRelativeFileName(buildInfoFile, sourceRoot)}`);
        cache.writeEmittedFile(fileName, data, writeByteOrderMark);
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
              sourceFiles[0].fileName,
              sourceRoot
            );
            if (fileName.match(/\.js$/)) {
              info(`Compiling ${relativeSourceFilePath}`);
              this.numCompiledFiles++;
              this.addJavascriptToCache(
                fileName,
                data,
                writeByteOrderMark,
                cache
              );
            }
            if (fileName.match(/\.map$/)) {
              cache.writeEmittedFile(fileName, data, writeByteOrderMark);
            }
          }
        }
      }
    );

    const combinedDiagnostics = diagnostics.concat(emitResult.diagnostics);
    this.writeDiagnostics(combinedDiagnostics, sourceRoot);

    const endTime = Date.now();
    const delta = endTime - startTime;
    info(
      `Compilation finished in ${msToSec(delta)} seconds. ${
        this.numCompiledFiles
      } files were (re)compiled.`
    );
    return {diagnostics: combinedDiagnostics}
  }

  createWatcher(sourceRoot: string): WatcherInstance {
    info(`Creating new Typescript watcher for ${sourceRoot}`);

    const configPath = ts.findConfigFile(
      /*searchPath*/ "./",
      ts.sys.fileExists,
      "tsconfig.json"
    );
    if (!configPath) {
      throw new Error("Could not find a valid 'tsconfig.json'.");
    }

    // Important to make these paths absolute, see https://github.com/microsoft/TypeScript/issues/41690
    // In "meteor test" mode. to not have simultanenous builds overwrite each other’s build files,
    // cacheRoot will be a temporary folder where .meteor/local/plugin-cache and some other dirs are symlinked in,
    // but Typescript wants the buildInfo file and outDir to be in a stable location relative the source dir
    // so get us back to the source dir version of the directory (it’s the same content, just symlinked so no harm done)
    // see tools/cli/commands.js for details
    const cacheRootRelativeSource = this.cacheRoot.substring(
      this.cacheRoot.indexOf("/.meteor/local")
    );

    const rootOutDir = ts.sys.resolvePath(
      `${sourceRoot}${cacheRootRelativeSource}/v2cache`
    );

    const outDir = `${rootOutDir}/out`;
    const buildInfoFile = `${rootOutDir}/buildfile.tsbuildinfo`;
    const cache = new CompilerCache(outDir);
    const optionsToExtend: ts.CompilerOptions = {
      incremental: true,
      tsBuildInfoFile: buildInfoFile,
      outDir,
      noEmit: false,
      sourceMap: true,
    };

    const watchHost = ts.createWatchCompilerHost(
      configPath,
      optionsToExtend,
      ts.sys,
      ts.createEmitAndSemanticDiagnosticsBuilderProgram,
      (diagnostic) => this.writeDiagnostics([diagnostic], sourceRoot),
      (...args) => this.reportWatchStatus(...args)
    );

    let diagnostics: ReadonlyArray<ts.Diagnostic> = [];

    watchHost.afterProgramCreate = (program) => {
      ({diagnostics} = this.emitAllAffectedFiles(program, cache, buildInfoFile, sourceRoot));
    };

    const watch = ts.createWatchProgram(watchHost);
    return { buildInfoFile, watch, cache, getLastDiagnostics() { return diagnostics; } };
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
  getWatcherFor(directory: string): WatcherInstance {
    const foundInCache = this.cachedWatchers.get(directory);
    if (foundInCache) {
      return foundInCache;
    }
    const newEntry = this.createWatcher(directory);
    this.cachedWatchers.set(directory, newEntry);
    return newEntry;
  }

  /**
   * Invoked by the Meteor compiler framework
   */
  public setDiskCacheDirectory(path: string) {
    super.setDiskCacheDirectory(path);
    this.cacheRoot = path;
  }

  writeDiagnosticMessage(message: string, category:ts.DiagnosticCategory) {
    switch (category) {
      case ts.DiagnosticCategory.Error:
        return error(message);
      case ts.DiagnosticCategory.Warning:
      case ts.DiagnosticCategory.Suggestion:
      case ts.DiagnosticCategory.Message:
        return info(message);
    }
  }

  writeDiagnostics(
    diagnostics: ReadonlyArray<ts.Diagnostic>,
    sourceRoot: string | undefined
  ) {
    for (const diagnostic of diagnostics) {
      const message = getDiagnosticMessage(diagnostic,sourceRoot);
      this.writeDiagnosticMessage(message, diagnostic.category);
    };
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

  addJavascriptToCache(
    targetPath: string,
    data: string,
    writeByteOrderMark: boolean,
    cache: CompilerCache
  ) {
    this.numFilesWritten++;
    cache.writeEmittedFile(targetPath, data, writeByteOrderMark);
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
    const sourcePath = inputFile.getPathInPackage();
    sourceMap.sources = [sourcePath];
    return sourceMap;
  }

  emitResultFromCacheData(
    cacheData: CacheData,
    inputFile: MeteorCompiler.InputFile,
    sourceFile: ts.SourceFile
  ): LocalEmitResult {
    const {
      sourceMapJson,
      javascript: { fileName, source },
    } = cacheData;
    const sourceMap = this.prepareSourceMap(
      sourceMapJson,
      inputFile,
      sourceFile
    );
    return { data: source, sourceMap, fileName };
  }

  emitForSource(
    inputFile: MeteorCompiler.InputFile,
    sourceFile: ts.SourceFile,
    program: BuilderProgramType,
    cache: CompilerCache
  ): LocalEmitResult | undefined {
    this.numEmittedFiles++;

    trace(`Emitting Javascript for ${inputFile.getPathInPackage()}`);
    program.emit(sourceFile, function (fileName, data, writeByteOrderMark) {
      cache.writeEmittedFile(fileName, data, writeByteOrderMark);
    });

    const sourcePath = inputFile.getPathInPackage();
    const compiledResult = cache.get(sourcePath);
    if (!compiledResult) {
      return undefined;
    }
    const result = this.emitResultFromCacheData(
      compiledResult,
      inputFile,
      sourceFile
    );
    return result;
  }

  getOutputForSource(
    inputFile: MeteorCompiler.InputFile,
    sourceFile: ts.SourceFile,
    program: BuilderProgramType,
    cache: CompilerCache
  ): LocalEmitResult | undefined {
    const fromCache = cache.get(inputFile.getPathInPackage());
    if (fromCache) {
      const result = this.emitResultFromCacheData(
        fromCache,
        inputFile,
        sourceFile
      );
      this.numFilesFromCache++;
      return result;
    }
    return this.emitForSource(inputFile, sourceFile, program, cache);
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
    program: BuilderProgramType,
    cache: CompilerCache,
    errors: ReadonlyArray<ts.Diagnostic>
  ) {
    const inputFilePath = inputFile.getPathInPackage();
    const sourceFile =
      program.getSourceFile(inputFilePath) ||
      program.getSourceFile(ts.sys.resolvePath(inputFilePath));

    if (!sourceFile) {
      trace(`Could not find source file for ${inputFilePath}`);
      return;
    }
    const errorsForFile = errors.filter(error=>error.file?.fileName===sourceFile.fileName);
    if (errorsForFile.length > 0) {
        const sourceRoot = inputFile.getSourceRoot(false);
        if (failOnErrors) {
          for (const diagnostic of errorsForFile) {            
            if (diagnostic.file && diagnostic.start !== undefined) {
              const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
              inputFile.error({
                func: "",
                line,
                sourcePath: inputFilePath,
                message: getDiagnosticMessage(diagnostic, sourceRoot)
              })
            }
          }
        }
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
          program,
          cache
        );
        if (!emitResult) {
          error(`Nothing emitted for ${inputFilePath}`);
          return {};
        }
        const { data, sourceMap } = emitResult;
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
    } catch (e: any) {
      error(e.message);
    }
  }

  clearStats() {
    this.numEmittedFiles = 0;
    this.numFilesFromCache = 0;
    this.numFilesWritten = 0;
    this.numStoredFiles = 0;
    this.numCompiledFiles = 0;
    this.processStartTime = 0;
  }

  // Called by the compiler plugins system after all linking and lazy
  // compilation has finished. (bundler.js)
  afterLink() {
    if (this.numStoredFiles > 0) {
      const endTime = Date.now();
      const delta = endTime - this.processStartTime;
      info(
        `Typescript summary: ${msToSec(delta)} seconds for sending ${
          this.numStoredFiles
        } transpiled files on for bundling`
      );
      if (this.numEmittedFiles > 0) {
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

    const firstInput = inputFiles[0];
    const sourceRoot =
      firstInput.getSourceRoot(false) || ts.sys.getCurrentDirectory();
    info(
      `Typescript processing requested for ${firstInput.getArch()} using Typescript ${
        ts.version
      }`
    );

    const { watch, cache, getLastDiagnostics } = this.getWatcherFor(sourceRoot);
    // This both produces all dirty files and provides us an instance to emit ad-hoc in case a file went missing
    const program = watch.getProgram();

    this.clearStats();
    this.processStartTime = Date.now();

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
    const errors = getLastDiagnostics().filter(d=>d.category===ts.DiagnosticCategory.Error);
    const compilableFiles = inputFiles.filter(isCompilableFile);
    for (const inputFile of compilableFiles) {
      this.emitResultFor(inputFile, program, cache, errors);
    }
  }
}

// I haven’t figured out how to use a proper export here
MeteorTypescriptCompiler = MeteorTypescriptCompilerImpl;
