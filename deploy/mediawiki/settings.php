<?php
declare(strict_types=1);

$wgServer = getenv('WG_SERVER') ?: $wgServer;
$wgScriptPath = '';
$wgArticlePath = '/wiki/$1';

$wgForceHTTPS = true;
$wgCookieSecure = true;
$wgDefaultRobotPolicy = 'noindex,nofollow';

$wgEnableEmail = false;
$wgEnableUploads = false;
$wgUseInstantCommons = false;
$wgForeignFileRepos = [];
$wgAllowExternalImages = false;

$wgGroupPermissions['*']['read'] = true;
$wgGroupPermissions['*']['edit'] = false;
$wgGroupPermissions['user']['edit'] = false;
$wgGroupPermissions['sysop']['edit'] = true;

foreach (['*', 'user', 'autoconfirmed', 'sysop', 'bureaucrat'] as $group) {
	$wgGroupPermissions[$group]['createaccount'] = false;
	$wgGroupPermissions[$group]['upload'] = false;
}
