module.exports = {
    parser: '@typescript-eslint/parser',
    plugins: ['@typescript-eslint', 'prettier'],
    extends: [
        'airbnb-base',
        'plugin:import/errors',
        'plugin:import/warnings',
        'plugin:prettier/recommended',
        'plugin:@typescript-eslint/recommended'
    ],
    rules: {
        'linebreak-style': 0,
        'import/prefer-default-export': 0,
        'prettier/prettier': 0,
        'import/extensions': 0,
        'no-use-before-define': 0,
        'import/no-unresolved': 0,
        'import/no-extraneous-dependencies': 0,
        // 테스트 또는 개발환경을 구성하는 파일에서는 devDependency 사용을 허용
        'no-shadow': 0,
        '@typescript-eslint/explicit-module-boundary-types': 0,
        'no-restricted-syntax': ['error', 'ForInStatement', 'WithStatement'],
        'class-methods-use-this': 0,
        'no-param-reassign': 0
    },
    ignorePatterns: ['node_modules/', 'dist/', 'build/']
};
