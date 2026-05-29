module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  verbose: true,
  transformIgnorePatterns: [
    '/node_modules/(?!(uuid)/)',
  ],
};
