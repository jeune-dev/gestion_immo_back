'use strict';

/**
 * Stratégie de tests (voir docs/TESTS.md).
 *
 *   unit         logique isolée : utils, validations, services purs, modèles
 *                (aucune base) — src/__tests__/unit
 *   integration  API HTTP réelle (supertest) sur une VRAIE base PostgreSQL,
 *                sécurité, contraintes SQL, transactions, concurrence
 *                — src/__tests__/integration
 *   e2e          parcours utilisateurs complets de bout en bout
 *                — src/__tests__/e2e
 *
 * Bases : `globalSetup` construit la base modèle (migrations + seeders) et en
 * clone une par worker → exécution PARALLÈLE isolée.
 *
 * Cibler des fichiers : `npx jest --runTestsByPath <fichiers>` (des chemins
 * placés APRÈS `--selectProjects` seraient lus comme des noms de projet).
 */
const commun = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/src/__tests__/setup/env.js'],
};

module.exports = {
  // Options GLOBALES (ignorées si placées dans un projet).
  testTimeout: 30000,
  globalSetup: '<rootDir>/src/__tests__/setup/globalSetup.js',
  maxWorkers: process.env.JEST_WORKERS || 2,
  // Un worker qui a accumulé plus que ce seuil (modules rechargés à chaque
  // fichier, instrumentation de couverture) est recyclé entre deux fichiers :
  // sans cela, ~120 fichiers épuisent la mémoire d'un poste de 8 Go.
  workerIdleMemoryLimit: process.env.JEST_WORKER_MEMOIRE || '600MB',
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/__tests__/**',
    '!src/migrations/**',
    '!src/seeders/**',
    '!src/server.js',
  ],
  coverageReporters: ['text-summary', 'json-summary', 'lcov'],
  // Seuils juste sous la couverture mesurée (95,3 / 85,3 / 94,5 / 96,1 %) :
  // toute baisse notable fait échouer `npm run test:coverage` et la CI.
  coverageThreshold: {
    global: { statements: 94, branches: 84, functions: 93, lines: 95 },
  },
  coverageDirectory: 'coverage',
  projects: [
    { ...commun, displayName: 'unit', testMatch: ['<rootDir>/src/__tests__/unit/**/*.test.js'] },
    {
      ...commun,
      displayName: 'integration',
      testMatch: ['<rootDir>/src/__tests__/integration/**/*.test.js'],
      setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup/routeHits.js'],
    },
    {
      ...commun,
      displayName: 'e2e',
      testMatch: ['<rootDir>/src/__tests__/e2e/**/*.test.js'],
      setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup/routeHits.js'],
    },
  ],
};
