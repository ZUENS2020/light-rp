type BindingEnv = {
  [K in keyof Cloudflare.Env]: Cloudflare.Env[K] extends string ? string : Cloudflare.Env[K];
};
/** Generated platform types support legacy V1 too; this deployment uses a V2 index. */
export type VectorizeV2QueryOptions = Omit<VectorizeQueryOptions, 'returnMetadata'> & {
  returnMetadata?: Exclude<VectorizeQueryOptions['returnMetadata'], boolean>;
};
type VectorizeV2Index = Omit<Cloudflare.Env['VECTORS'], 'query' | 'queryById'> & {
  query(
    vector: VectorFloatArray | number[],
    options?: VectorizeV2QueryOptions,
  ): Promise<VectorizeMatches>;
  queryById(vectorId: string, options?: VectorizeV2QueryOptions): Promise<VectorizeMatches>;
};
export type Env = Omit<BindingEnv, 'VECTORS'> & {
  VECTORS: VectorizeV2Index;
  MODEL_API_KEY?: string;
  AI_GATEWAY_TOKEN?: string;
};
export type AppEnv = { Bindings: Env; Variables: { ownerId: string } };
