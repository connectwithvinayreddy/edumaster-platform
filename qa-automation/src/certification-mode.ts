export type CertificationMode =
  | 'prod_safe_existing_data_only'
  | 'full_certification_seeded_env';

const normalizeMode = (value: string | undefined | null): CertificationMode => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'prod_safe_existing_data_only' || normalized === 'prod-safe-existing-data-only') {
    return 'prod_safe_existing_data_only';
  }
  return 'full_certification_seeded_env';
};

export const certificationMode: CertificationMode = normalizeMode(process.env.QA_CERT_MODE);

export const isProdSafeExistingDataMode = () => certificationMode === 'prod_safe_existing_data_only';

export const assertMutationAllowed = (action: string) => {
  if (isProdSafeExistingDataMode()) {
    throw new Error(
      `${action} is disabled when QA_CERT_MODE=prod_safe_existing_data_only. ` +
      'Provide existing QA testers, existing manifests, and existing target ids instead of creating data.',
    );
  }
};

export const requireValueInProdSafeMode = (name: string, value: string) => {
  if (isProdSafeExistingDataMode() && !String(value || '').trim()) {
    throw new Error(`${name} is required when QA_CERT_MODE=prod_safe_existing_data_only.`);
  }
};

export const certificationModeSummary = () => ({
  mode: certificationMode,
  prodSafeExistingDataOnly: isProdSafeExistingDataMode(),
});
