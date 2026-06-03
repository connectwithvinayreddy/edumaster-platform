const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const repoRoot = path.resolve(__dirname, '..');
const requestedEnvFile = process.env.ENV_FILE ? path.resolve(repoRoot, process.env.ENV_FILE) : null;
const candidateEnvFiles = [
  path.join(repoRoot, 'functions', '.env'),
  requestedEnvFile || path.join(repoRoot, '.env.production'),
];
const explicitEnvRequested = Boolean(process.env.ENV_FILE);

candidateEnvFiles.forEach((filePath) => {
  if (fs.existsSync(filePath)) {
    dotenv.config({
      path: filePath,
      override: explicitEnvRequested ? filePath === requestedEnvFile : path.basename(filePath) === '.env.production',
    });
  }
});

process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const { getProductionConfigDiagnostics, getConfigSummary } = require(path.join(repoRoot, 'backend', 'lib', 'config.js'));

const diagnostics = getProductionConfigDiagnostics();

if (diagnostics.errors.length > 0) {
  console.error('Production configuration is invalid:');
  diagnostics.errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log('Production configuration looks valid.');
console.log(JSON.stringify(getConfigSummary(), null, 2));

if (diagnostics.warnings.length > 0) {
  console.warn('Warnings:');
  diagnostics.warnings.forEach((warning) => console.warn(`- ${warning}`));
}
