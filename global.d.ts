import type { MeteorTypescriptCompilerImpl } from "./meteor-typescript-compiler";

declare global {
  var MeteorTypescriptCompiler: typeof MeteorTypescriptCompilerImpl;
  class BabelCompiler {
    constructor(extraFeatures: MeteorCompiler.BabelFeatures);

    /**
     * IsoBuild compiler plugin signature
     */
    public processFilesForTarget(inputFiles: MeteorCompiler.InputFile[]): void;

    public processOneFileForTarget(
      inputfile: MeteorCompiler.InputFile,
      /**
       * Can be used to provide the mutated source if you’ve done some pre-processing
       */
      source: string | undefined
    ): MeteorCompiler.AddJavaScriptOptions;

    public inferExtraBabelOptions(
      inputfile: MeteorCompiler.InputFile,
      babelOptions: any,
      cacheDeps: any
    ): boolean;

    /** Introduced in Meteor 3.3 and used if "modern" is enabled in package.json */
    public inferExtraSWCOptions(
      inputfile: MeteorCompiler.InputFile,
      swcOptions: any,
      cacheDeps: any
    ): boolean;

    public setDiskCacheDirectory(path: string): void;
  }
}
