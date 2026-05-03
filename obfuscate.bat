@echo off
mkdir dist 2>nul
' npm install javascript-obfuscator --save-dev

type src\collector.js src\input_controls.js src\scope_controls.js src\main.js > dist\app.concat.js
npx javascript-obfuscator dist/app.concat.js  --output dist/app.js --compact true --control-flow-flattening true --dead-code-injection true
