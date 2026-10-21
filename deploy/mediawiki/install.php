<?php
declare(strict_types=1);

const CONFIG_DIR = '/var/www/config';
const LOCAL_SETTINGS = CONFIG_DIR . '/LocalSettings.php';
const SETTINGS_MARKER = "// HASI deployment settings (managed by deploy/mediawiki).";
const SETTINGS_REQUIRE = "require_once '/usr/local/etc/mediawiki/settings.php';";

function failInstall(string $message): never {
	fwrite(STDERR, "hasi-mediawiki installer: $message\n");
	exit(1);
}

function readSecret(string $environmentName, string $defaultPath): string {
	$path = getenv($environmentName) ?: $defaultPath;
	if (!is_file($path) || !is_readable($path)) {
		failInstall('a required secret file is unavailable.');
	}
	$value = @file_get_contents($path);
	if (!is_string($value)) {
		failInstall('a required secret file could not be read.');
	}
	$value = trim($value, "\r\n");
	if ($value === '') {
		failInstall('a required secret file is empty.');
	}
	return $value;
}

$server = getenv('WG_SERVER');
$parts = is_string($server) ? parse_url($server) : false;
if (!is_array($parts)
	|| strtolower($parts['scheme'] ?? '') !== 'https'
	|| empty($parts['host'])
	|| isset($parts['user'])
	|| isset($parts['pass'])
	|| array_key_exists('path', $parts)
	|| array_key_exists('query', $parts)
	|| array_key_exists('fragment', $parts)) {
	failInstall('WG_SERVER must be an HTTPS origin with no path, query, or fragment.');
}

$databaseHost = getenv('WIKI_DB_HOST') ?: 'wiki-database';
if (preg_match('/\A[A-Za-z0-9.-]+\z/D', $databaseHost) !== 1) {
	failInstall('WIKI_DB_HOST contains invalid characters.');
}

$adminName = getenv('WIKI_ADMIN_USER') ?: 'wikiadmin';
if (preg_match('/\A[A-Za-z0-9 _.-]{1,80}\z/D', $adminName) !== 1) {
	failInstall('WIKI_ADMIN_USER contains invalid characters.');
}

$adminPassword = readSecret('WIKI_ADMIN_PASSWORD_FILE', '/run/secrets/wiki-admin-password');
$databasePassword = readSecret('WIKI_DB_PASSWORD_FILE', '/run/secrets/wiki-db-password');
$adminPasswordFile = getenv('WIKI_ADMIN_PASSWORD_FILE') ?: '/run/secrets/wiki-admin-password';
$databasePasswordFile = getenv('WIKI_DB_PASSWORD_FILE') ?: '/run/secrets/wiki-db-password';

if (file_exists(LOCAL_SETTINGS) || is_link(LOCAL_SETTINGS)) {
	failInstall('persistent configuration already exists; refusing to reinstall.');
}
if (!is_dir(CONFIG_DIR) || !is_writable(CONFIG_DIR)) {
	failInstall('the persistent configuration directory is unavailable or not writable.');
}

if (function_exists('sodium_memzero')) {
	sodium_memzero($adminPassword);
	sodium_memzero($databasePassword);
}
unset($adminPassword, $databasePassword);

$GLOBALS['argv'] = [
	'/var/www/html/maintenance/install.php',
	'HASI Wissen',
	$adminName,
	'--lang=en',
	'--server=' . $server,
	'--scriptpath=',
	'--dbtype=mysql',
	'--dbserver=' . $databaseHost,
	'--dbname=wiki',
	'--dbuser=wiki',
	'--dbpassfile=' . $databasePasswordFile,
	'--passfile=' . $adminPasswordFile,
	'--confpath=' . CONFIG_DIR,
];
$_SERVER['argv'] = $GLOBALS['argv'];
$_SERVER['argc'] = count($GLOBALS['argv']);

require '/var/www/html/maintenance/install.php';

if (!is_file(LOCAL_SETTINGS) || !is_readable(LOCAL_SETTINGS)) {
	failInstall('MediaWiki did not generate LocalSettings.php.');
}

$generated = @file_get_contents(LOCAL_SETTINGS);
if (!is_string($generated) || str_contains($generated, SETTINGS_MARKER)) {
	failInstall('MediaWiki generated an invalid LocalSettings.php.');
}

$completeConfig = rtrim($generated) . "\n\n" . SETTINGS_MARKER . "\n" . SETTINGS_REQUIRE . "\n";
$temporaryPath = CONFIG_DIR . '/.LocalSettings.php.' . bin2hex(random_bytes(12)) . '.tmp';
$written = @file_put_contents($temporaryPath, $completeConfig, LOCK_EX);
if ($written !== strlen($completeConfig) || !@chmod($temporaryPath, 0640)) {
	@unlink($temporaryPath);
	failInstall('the persistent configuration could not be staged safely.');
}
if (!@rename($temporaryPath, LOCAL_SETTINGS)) {
	@unlink($temporaryPath);
	failInstall('the complete persistent configuration could not be published.');
}

unset($GLOBALS['argv'], $_SERVER['argv'], $_SERVER['argc']);
