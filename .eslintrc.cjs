module.exports = {
  extends: ['plugin:prettier/recommended'],
  env: {
    node: true,
    commonjs: true,
    es2021: true,
  },
  plugins: ['prettier', 'node'],
  parserOptions: {
    sourceType: 'module',
  },
  rules: {
    quotes: [
      'error',
      'single',
      { avoidEscape: true, allowTemplateLiterals: false },
    ],
  },
};
