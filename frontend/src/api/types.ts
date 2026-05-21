/**
 * Shared response shapes for the API layer (Phase 2.3).
 *
 * Keep these close to the wire — they mirror backend pydantic schemas. When
 * the backend adds a field, add it here first and the TS compiler will flag
 * every consumer that needs to handle it.
 *
 * When a shape is still evolving, leave it `Record<string, unknown>` rather
 * than lying with a fake type — explicit "unknown" prompts a runtime check.
 */

// ── Engines (Phase 3 / 4.6) ──────────────────────────────────────────────
export type EngineFamily = 'tts' | 'asr' | 'llm' | 'translation';

export interface EngineBackend {
  id: string;
  display_name: string;
  available?: boolean;
  reason?: string | null;
  installed?: boolean;
  availability_reason?: string | null;
  dependency_installed?: boolean;
  model_installed?: boolean | null;
  model_repo_id?: string;
  pip_package?: string | null;
  runtime_status?: string | null;
  runtime_detail?: string | null;
  runtime_progress_pct?: number | null;
  running?: boolean;
}

export interface EngineFamilyResponse {
  active: string;
  backends: EngineBackend[];
}

export interface AllEnginesResponse {
  tts: EngineFamilyResponse;
  asr: EngineFamilyResponse;
  llm: EngineFamilyResponse;
  translation?: EngineFamilyResponse & { sandboxed?: boolean };
}

export interface SelectEngineResponse {
  family: EngineFamily;
  active: string;
  env_override: boolean;
}

// ── System / diagnostics ─────────────────────────────────────────────────
export interface SystemInfo {
  app_version?: string;
  python?: string;
  platform?: string;
  device?: string;
  data_dir?: string;
  outputs_dir?: string;
  storage_root?: string | null;
  storage_volume?: string | null;
  storage_external?: boolean;
  hf_cache_dir?: string;
  model_checkpoint?: string;
  asr_model?: string;
  translate_provider?: string;
  idle_timeout_seconds?: number;
  has_hf_token?: boolean;
  credentials?: CredentialStatus[];
}

export interface CredentialStatus {
  key: string;
  label: string;
  category: string;
  configured: boolean;
  secret?: boolean;
  description?: string;
  source?: string | null;
}

export interface ModelStatus {
  status: 'idle' | 'loading' | 'ready' | string;
  checkpoint?: string;
  loaded_at?: string;
}

export interface LogsResponse {
  path: string;
  exists: boolean;
  lines: string[];
  candidates?: string[];
}

export interface ClearTauriResponse {
  cleared: string[];
}

// ── Projects ─────────────────────────────────────────────────────────────
export interface ProjectSummary {
  id: string;
  name: string;
  updated_at: string;
  created_at: string;
  language_code?: string;
}

export interface ProjectDetail extends ProjectSummary {
  segHashes?: Record<string, string>;
  state_json?: string;
  [key: string]: unknown;
}

// ── Profiles (voice library) ─────────────────────────────────────────────
export type ProfileKind = 'clone' | 'design';

export interface Profile {
  id: string;
  name: string;
  kind: ProfileKind;
  language_code?: string;
  ref_audio?: string;
  ref_audio_path?: string;
  locked_audio_path?: string;
  photo_path?: string;
  ref_text?: string;
  instruct?: string;
  language?: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
  is_locked?: boolean;
}

export interface ProfileUsage {
  projects: { project_id: string; project_name: string; segment_count: number }[];
  total_segments: number;
}

// ── Glossary ─────────────────────────────────────────────────────────────
export interface GlossaryTerm {
  id: number;
  source: string;
  target: string;
  source_lang?: string;
  target_lang?: string;
  auto?: boolean;
  notes?: string;
}

export interface AutoExtractResponse {
  added: GlossaryTerm[];
  skipped: number;
}

// ── Dub pipeline ─────────────────────────────────────────────────────────
export interface DubJobMeta {
  id: string;
  status: string;
  filename?: string;
  language_code?: string;
  dubbed_tracks?: Record<string, string>;
  created_at?: string;
  seg_hashes?: Record<string, string>;
}

export interface DubHistoryResponse {
  jobs: DubJobMeta[];
}

export interface DubTranslateResponse {
  segments: { id: string; text: string; text_original?: string; rate_ratio?: number; rate_error?: string }[];
}

// ── Generic ──────────────────────────────────────────────────────────────
export interface DeletedResponse {
  deleted: boolean | number;
}
