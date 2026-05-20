type ModelScanLike = {
  status?: string | null;
  progress_pct?: number | null;
  detail?: string | null;
};

export function selectModelScanView({
  dataScan,
  liveScan,
  isFetching,
}: {
  dataScan?: ModelScanLike | null;
  liveScan?: ModelScanLike | null;
  isFetching?: boolean;
}): ModelScanLike | null {
  if (isFetching && liveScan?.status === 'scanning') return liveScan;
  return dataScan || liveScan || null;
}
