/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests', '<rootDir>/agents'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@jetpayment/core$': '<rootDir>/packages/core/src',
    '^@jetpayment/core/(.*)$': '<rootDir>/packages/core/src/$1',
    '^@jetpayment/protocol-native$': '<rootDir>/packages/protocol-native/src',
    '^@jetpayment/protocol-native/(.*)$': '<rootDir>/packages/protocol-native/src/$1',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
