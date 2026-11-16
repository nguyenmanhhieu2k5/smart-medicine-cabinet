# Release checklist for Smart Medicine Cabinet

This checklist is derived from the project README and the current state of the repository.

## 1. Release gate: must be true before public release

### Build and install
- [ ] Build succeeds on a clean Windows 10/11 machine without requiring a developer environment.
- [ ] `setup-windows.bat` works on a fresh Windows installation with Python 3.11-3.13 x64 and Node.js 20+.
- [ ] `build-windows.bat` produces a signed or clearly labeled Windows installer with a valid artifact name.
- [ ] The installer can be installed and launched without opening a terminal.
- [ ] App runs from the installed version, not only from source.

### Runtime validation
- [ ] App starts successfully on Windows from the generated `.exe`.
- [ ] Electron backend starts/stops correctly without leaving hung processes.
- [ ] Database initializes and catalog import works on a clean machine.
- [ ] OCR model is bundled and works on a machine without internet access.
- [ ] OCR is validated against real-world medicine packaging images.
- [ ] Camera flow works with the default supported webcam on a clean Windows machine.
- [ ] App can handle missing camera permissions and show helpful instructions.

### Device integration
- [ ] ESP32 firmware has been tested on real hardware, not only via simulator.
- [ ] README and release notes clearly mark ESP32 as optional.
- [ ] App shows a clean fallback state when device is not connected.
- [ ] HTTP polling and WebSocket mode are tested against actual device behavior.

### TTS / voice support
- [ ] If app depends on Windows system voices, app detects missing voice and displays clear instructions.
- [ ] If a bundled voice is required for public use, licensing and distribution are verified.
- [ ] The app can read text with a fallback voice or disable itself gracefully.

### Data and legal
- [ ] Ownership and license of `data/DAV_unique.xlsx` are confirmed.
- [ ] Release notes state clearly what data is included and whether users must add their own catalog.
- [ ] The app does not claim to be a medical device or provide medical advice.
- [ ] Privacy/security notes are included with the release.

### Security and quality
- [ ] Installer is signed to reduce SmartScreen warnings.
- [ ] Required app tokens, secrets, and environment variables are not committed in source files.
- [ ] Backend listens only on local addresses and token validation is enforced for device access.
- [ ] Update path and rollback strategy are documented.
- [ ] Crash logs and backend log directory are easy to access for support.

### Release process
- [ ] A version is set in `package.json` and release notes are published.
- [ ] A GitHub tag and release are created from the verified artifact.
- [ ] A short troubleshooting section is included for common installation errors.
- [ ] At least one real Windows user test has passed before public distribution.

## 2. Exit criteria for public release

The app is publicly releasable only if all critical items are checked and no blocker item remains open.

Critical blockers:
- Windows installer cannot be generated or launched successfully
- OCR cannot function reliably on real package images
- App cannot run without manual terminal work on a clean machine
- Data rights or licensing are unclear
- Installer is unsigned and cannot be trusted by users without warnings

## 3. Recommended order of work

1. Validate Windows installer on a clean VM
2. Fix any install/startup blockers
3. Validate OCR with real package images
4. Validate ESP32 on hardware
5. Document TTS behavior and licensing
6. Add signed release workflow
7. Publish GitHub Release and release notes

## 4. Suggested owner split

- Windows build and release: maintainer / release engineer
- OCR and scanning: model and validation engineer
- Device/ESP32: hardware integration engineer
- Compliance and legal: project lead
- QA: one or two end users on clean Windows machines

## 5. Notes from the project README

The project README explicitly states that:
- testing was done mainly on Linux
- Windows install and real hardware validation are not fully complete
- ESP32 and webcam real-world validation are pending
- TTS depends on Windows installed voices
- installer is not signed yet

Those are not blockers for a private research build, but they are release blockers for public distribution.
