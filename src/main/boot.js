// Entry point. The same binary runs either the editor or, when launched by Setup.exe with
// --installer, the installation wizard (so the wizard can use the app's own UI engine).
if (process.argv.includes('--installer')) require('./installer/wizard');
else require('./main');
