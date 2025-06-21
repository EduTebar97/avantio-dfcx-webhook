module.exports = {
  root: true,
  env: {
    es6: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
    "google",
  ],
  parserOptions: {
    ecmaVersion: 2020, // O la versión que estés usando (ej. Node 18 usa ES2022 aprox)
  },
  rules: {
    "quotes": ["error", "double"],
    "require-jsdoc": "off", // Desactiva la necesidad de JSDoc por ahora
    "max-len": ["warn", {  // Cambia "error" a "warn" y aumenta el límite
      "code": 120,         // Límite de 120 caracteres
      "ignoreComments": true,
      "ignoreUrls": true,
      "ignoreStrings": true,
      "ignoreTemplateLiterals": true,
      "ignoreRegExpLiterals": true,
    }],
    "object-curly-spacing": ["error", "never"], // o "always" según preferencia
    "comma-dangle": ["error", "always-multiline"], // Estilo Google
    "indent": ["error", 2], // Indentación de 2 espacios
  },
};



