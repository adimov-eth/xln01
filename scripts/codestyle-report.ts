#!/usr/bin/env bun
import { execSync } from 'child_process';

console.log('📊 XLN Code Style Compliance Report\n');

// Run verification script
const output = execSync('bun run scripts/verify-codestyle.ts 2>&1 || true', { encoding: 'utf-8' });

// Parse violations
const summaryMatch = output.match(/📋 Summary by rule:([\s\S]*?)$/);
const violations: Record<string, number> = {};
let totalViolations = 0;

if (summaryMatch) {
	const lines = summaryMatch[1].trim().split('\n');
	for (const line of lines) {
		const match = line.match(/\s*(.+?):\s*(\d+)\s*violations/);
		if (match) {
			violations[match[1]] = parseInt(match[2]);
			totalViolations += parseInt(match[2]);
		}
	}
}

// Define weights for different violation types
const weights: Record<string, number> = {
	'naming/no-abbreviations': 0.2,
	'pattern/use-roro': 0.25,
	'type-safety/no-any': 0.2,
	'functional/no-throw': 0.25,
	'no-magic-numbers': 0.1,
};

// Calculate scores
const maxViolationsPerRule = 100; // Assume 100 violations = 0 score
const scores: Record<string, number> = {};
let weightedScore = 0;

for (const [rule, weight] of Object.entries(weights)) {
	const count = violations[rule] || 0;
	const score = Math.max(0, 100 - (count / maxViolationsPerRule) * 100);
	scores[rule] = score;
	weightedScore += score * weight;
}

// Display report
console.log('Current Violations:');
console.log('─'.repeat(50));
for (const [rule, count] of Object.entries(violations)) {
	const score = scores[rule] || 100;
	const status = score >= 80 ? '✅' : score >= 50 ? '⚠️' : '❌';
	console.log(`${status} ${rule.padEnd(30)} ${count.toString().padStart(3)} violations (${Math.round(score)}% compliant)`);
}

console.log('\n' + '─'.repeat(50));
console.log(`Total Violations: ${totalViolations}`);
console.log(`Overall Compliance Score: ${Math.round(weightedScore)}%`);

// Grade calculation
const grade = 
	weightedScore >= 90 ? 'A' :
	weightedScore >= 80 ? 'B' :
	weightedScore >= 70 ? 'C' :
	weightedScore >= 60 ? 'D' : 'F';

console.log(`Grade: ${grade}`);

// Recommendations
console.log('\n📋 Priority Recommendations:');
const recommendations = [
	{ rule: 'naming/no-abbreviations', count: violations['naming/no-abbreviations'] || 0, fix: 'Run global rename for common abbreviations (tx→transaction, msg→message, etc.)' },
	{ rule: 'pattern/use-roro', count: violations['pattern/use-roro'] || 0, fix: 'Convert multi-parameter functions to single object parameter pattern' },
	{ rule: 'functional/no-throw', count: violations['functional/no-throw'] || 0, fix: 'Replace throw statements with Result<T,E> type returns' },
	{ rule: 'type-safety/no-any', count: violations['type-safety/no-any'] || 0, fix: "Replace 'any' with 'unknown' and add proper type guards" },
];

recommendations
	.filter(r => r.count > 0)
	.sort((a, b) => b.count - a.count)
	.slice(0, 3)
	.forEach((rec, i) => {
		console.log(`${i + 1}. ${rec.fix} (${rec.count} violations)`);
	});

// Quick wins
console.log('\n🚀 Quick Wins (< 30 minutes):');
console.log('1. Enable @typescript-eslint/no-explicit-any in ESLint config');
console.log('2. Run Prettier to ensure consistent formatting');
console.log('3. Extract remaining magic numbers to constants.ts');

console.log('\n✨ Run `bun run scripts/verify-codestyle.ts` for detailed violations');