type TranslationEngineStatusLike = {
  display_name?: string;
  installed?: boolean;
  pip_package?: string | null;
  model_repo_id?: string | null;
  model_installed?: boolean | null;
  runtime_status?: string | null;
};

export function translationEngineOptionLabel(engine: TranslationEngineStatusLike): string {
  const name = engine.display_name || 'Translation engine';
  if (engine.installed !== false) return name;
  if (engine.model_repo_id && engine.model_installed === false) {
    return `${name} — needs model install`;
  }
  if (engine.pip_package) {
    return `${name} — needs package install`;
  }
  return `${name} — unavailable`;
}

export function translationRuntimeLabel(engine: TranslationEngineStatusLike): string {
  const status = engine.runtime_status || 'idle';
  if (status === 'generating') return 'running';
  if (status === 'loading') return 'loading';
  if (status === 'ready') return 'loaded';
  if (status === 'error') return 'error';
  return 'idle';
}

export function translationEngineStatusTone(engine: TranslationEngineStatusLike): 'success' | 'warn' | 'info' | 'danger' | 'neutral' {
  if (engine.installed === false) return 'warn';
  if (engine.runtime_status === 'error') return 'danger';
  if (engine.runtime_status === 'loading' || engine.runtime_status === 'generating') return 'info';
  if (engine.runtime_status === 'ready') return 'success';
  return 'neutral';
}

export function translationEngineUnavailableHint(engine: TranslationEngineStatusLike): string {
  if (engine.model_repo_id && engine.model_installed === false) {
    return 'Download this model from Settings > Models before translating.';
  }
  if (engine.pip_package) {
    return `Install the ${engine.pip_package} package before translating.`;
  }
  return 'This translation engine is not ready.';
}
