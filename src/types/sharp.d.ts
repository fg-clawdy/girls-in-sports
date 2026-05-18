declare module "sharp" {
  interface Sharp {
    resize(width: number, height: number, options?: any): Sharp;
    composite(inputs: Array<{ input: Buffer; left?: number; top?: number }>): Sharp;
    png(): Sharp;
    toBuffer(): Promise<Buffer>;
    metadata(): Promise<{ format?: string }>;
  }
  function sharp(input?: Buffer | string | { create: any }): Sharp;
  export = sharp;
}
