#!/usr/bin/env python3
"""Execute the real compiled game DLL initializers in a browser worker.

This asserts that real WASM, binary verification and DLL loading work. It
records the first unsupported guest operation; it is NOT a gameplay test.
Requires a running server and tools/package_runtime.py output.
"""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright


def main(url):
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader',
                                         '--autoplay-policy=no-user-gesture-required'])
        page = browser.new_page()
        page.set_default_timeout(90000)
        page.goto(url)
        result = page.evaluate('''async () => {
          if (!crossOriginIsolated) throw Error('Missing cross-origin isolation');
          const status = await (await fetch('/api/status')).json();
          if (!status.runtime.installed || !status.runtime.diagnostics) throw Error('Diagnostic WASM runtime not installed');
          const maps = await (await fetch('/api/maps')).json();
          const module = await import(status.runtime.moduleUrl);
          const canvas = document.createElement('canvas'); canvas.width=640;canvas.height=480;document.body.append(canvas);
          const log=[];
          const report = await new Promise((resolve,reject) => {
            module.runDiagnostics({canvas,wasmUrl:status.runtime.wasmUrl,audioEnabled:true,timeout:60000,
              onStatus:message=>log.push(message),onReport:resolve}).catch(reject);
          });
          return {report,log,mapCount:maps.count,capabilities:status.runtime.capabilities};
        }''')
        browser.close()
    Path('var/reports').mkdir(parents=True, exist_ok=True)
    Path('var/reports/runtime-browser-boot.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    report = result['report']
    assert report['wasmExecuted'] is True, report
    assert report['profileVerified'] is True, report
    assert len(report['modules']) == 4, report
    assert report['gameplayVerified'] is False, 'Boot smoke must never claim gameplay'
    assert not any(result['capabilities'].values()), 'Unverified gameplay modes must stay disabled'
    assert report['calls'], 'No guest import was executed'
    assert result['mapCount'] > 0
    print(json.dumps({'stage': report['stage'], 'guestCalls': sum(report['calls'].values()),
                      'mapCount':result['mapCount'], 'stop':report.get('error',{}).get('message'),
                      'gameplayVerified': False}, ensure_ascii=False))


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',default='http://127.0.0.1:8080')
    main(parser.parse_args().url)
