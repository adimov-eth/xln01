#!/usr/bin/env bun
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

type Violation = {
	file: string;
	line: number;
	rule: string;
	message: string;
};

const violations: Violation[] = [];

// Check for abbreviated variables
const ABBREVIATIONS = new Map([
	['pr', 'privateKey'],
	['pb', 'publicKey'],
	['rep', 'replica'],
	['st', 'state'],
]);

// Crypto-standard abbreviations that are accepted
const ACCEPTED_CRYPTO_ABBREVIATIONS = ['tx', 'msg', 'sig', 'addr'];

// Functions that should start with verbs
const VERB_PREFIXES = ['get', 'set', 'create', 'make', 'is', 'has', 'can', 'should', 'calculate', 'compute', 'convert', 'derive', 'validate', 'execute', 'apply', 'process', 'handle'];

function checkFile(filePath: string) {
	if (!filePath.endsWith('.ts') || filePath.includes('node_modules') || filePath.includes('.test.')) {
		return;
	}

	const content = readFileSync(filePath, 'utf-8');
	const lines = content.split('\n');

	lines.forEach((line, index) => {
		const lineNum = index + 1;

		// Check for abbreviated variables
		for (const [abbr, full] of ABBREVIATIONS) {
			const regex = new RegExp(`\\b${abbr}\\b(?!:)`, 'g');
			if (regex.test(line) && !line.includes('//') && !line.includes('*')) {
				violations.push({
					file: filePath,
					line: lineNum,
					rule: 'naming/no-abbreviations',
					message: `'${abbr}' should be '${full}'`,
				});
			}
		}

		// Check for functions not starting with verbs
		const funcMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
		if (funcMatch) {
			const funcName = funcMatch[1];
			const startsWithVerb = VERB_PREFIXES.some(prefix => funcName.startsWith(prefix));
			if (!startsWithVerb && funcName !== 'constructor') {
				violations.push({
					file: filePath,
					line: lineNum,
					rule: 'naming/function-verb-prefix',
					message: `Function '${funcName}' should start with a verb`,
				});
			}
		}

		// Check for 'any' type usage
		if (line.includes(': any') || line.includes('<any>') || line.includes('as any')) {
			violations.push({
				file: filePath,
				line: lineNum,
				rule: 'type-safety/no-any',
				message: `Use 'unknown' instead of 'any'`,
			});
		}

		// Check for functions with multiple positional parameters
		// Match regular functions, arrow functions, and method signatures
		const patterns = [
			/(?:export\s+)?(?:const\s+)?(\w+)\s*=\s*(?:async\s+)?\(([^)]+)\)\s*(?:=>|:)/,
			/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]+)\)/,
			/(\w+)\s*:\s*(?:async\s+)?\(([^)]+)\)\s*=>/,
		];
		
		for (const pattern of patterns) {
			const match = line.match(pattern);
			if (match) {
				const funcName = match[1];
				const params = match[2].split(',').map(p => p.trim()).filter(p => p.length > 0);
				
				// Skip if it's already using object destructuring or has 1 or fewer params
				if (params.length > 1 && !params[0].includes('{') && !params[0].includes('...')) {
					// Skip certain common patterns that are OK
					if (!['forEach', 'map', 'filter', 'reduce', 'sort'].includes(funcName)) {
						violations.push({
							file: filePath,
							line: lineNum,
							rule: 'pattern/use-roro',
							message: `Function '${funcName}' with ${params.length} params should use RORO pattern`,
						});
					}
				}
				break;
			}
		}

		// Check for magic numbers (exclude numbers in identifiers like bls12_381)
		const magicNumberMatch = line.match(/\b(?<!\.)(?<!\w)\d+\b(?!\w)(?!\s*[:=]\s*)/g);
		if (magicNumberMatch && !line.includes('const') && !line.includes('//')) {
			magicNumberMatch.forEach(num => {
				// Common exceptions: 0, 1, 2 for array access/padding, 16 for hex
				if (num !== '0' && num !== '1' && num !== '2' && num !== '16') {
					violations.push({
						file: filePath,
						line: lineNum,
						rule: 'no-magic-numbers',
						message: `Magic number '${num}' should be extracted to a constant`,
					});
				}
			});
		}

		// Check for throw statements
		if (line.includes('throw ')) {
			violations.push({
				file: filePath,
				line: lineNum,
				rule: 'functional/no-throw',
				message: `Use Result type instead of throwing errors`,
			});
		}
	});
}

function scanDirectory(dir: string) {
	const entries = readdirSync(dir);
	
	for (const entry of entries) {
		const fullPath = join(dir, entry);
		const stat = statSync(fullPath);
		
		if (stat.isDirectory() && !entry.startsWith('.') && entry !== 'node_modules') {
			scanDirectory(fullPath);
		} else if (stat.isFile()) {
			checkFile(fullPath);
		}
	}
}

// Run verification
console.log('🔍 Verifying code style compliance...\n');
scanDirectory('./src');

// Group violations by rule
const violationsByRule = violations.reduce((acc, v) => {
	if (!acc[v.rule]) acc[v.rule] = [];
	acc[v.rule].push(v);
	return acc;
}, {} as Record<string, Violation[]>);

// Report results
if (violations.length === 0) {
	console.log('✅ No style violations found!');
} else {
	console.log(`❌ Found ${violations.length} style violations:\n`);
	
	for (const [rule, ruleViolations] of Object.entries(violationsByRule)) {
		console.log(`\n${rule} (${ruleViolations.length} violations):`);
		ruleViolations.slice(0, 5).forEach(v => {
			console.log(`  ${v.file}:${v.line} - ${v.message}`);
		});
		if (ruleViolations.length > 5) {
			console.log(`  ... and ${ruleViolations.length - 5} more`);
		}
	}
	
	console.log('\n📋 Summary by rule:');
	for (const [rule, ruleViolations] of Object.entries(violationsByRule)) {
		console.log(`  ${rule}: ${ruleViolations.length} violations`);
	}
}

process.exit(violations.length > 0 ? 1 : 0);