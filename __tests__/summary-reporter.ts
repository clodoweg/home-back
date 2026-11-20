class SummaryReporter {
  onTestRunEnd(testModules: any[] = []) {
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    let total = 0;

    testModules.forEach((module: any) => {
      // Use the allTests() generator if available, or just traverse children
      const tests = module.children?.array?.() || [];
      this.processCollection(tests, (state: any) => {
        total++;
        if (state === 'passed') passed++;
        else if (state === 'failed') failed++;
        else if (state === 'skipped') skipped++;
      });
    });

    process.stdout.write('\n' + '='.repeat(40) + '\n');
    process.stdout.write('       🧪 FINAL TEST SUMMARY\n');
    process.stdout.write('='.repeat(40) + '\n');
    process.stdout.write(` ✅ Passed:  ${passed}\n`);
    process.stdout.write(` ❌ Failed:  ${failed}\n`);
    if (skipped > 0) process.stdout.write(` ⏭️  Skipped: ${skipped}\n`);
    process.stdout.write('-'.repeat(40) + '\n');
    process.stdout.write(` 📊 Total:   ${total}\n`);
    process.stdout.write('='.repeat(40) + '\n\n');
  }

  processCollection(items: any[], callback: (state: any) => void) {
    items.forEach((item: any) => {
      if (item.type === 'test') {
        callback(item.result?.().state || 'pending');
      } else if (item.children) {
        this.processCollection(item.children.array(), callback);
      }
    });
  }
}

export default SummaryReporter;
