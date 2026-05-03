# ADTMC+ Medic Support Tool

**ADTMC+** is a unified, offline-capable clinical decision support application designed specifically for military medical personnel. It combines the **ADTMC Triage Assistant** and the **MSK Screening Tool** into a single, high-performance web application.

## Features
* **Standalone Architecture**: The entire application (HTML, CSS, JavaScript, and fonts) is bundled into a single `index.html` file (~1.2MB), allowing it to run completely offline without external dependencies.
* **Session Isolation**: Automatically resets all clinical forms and symptom checkboxes when navigating between tools, preventing cross-patient data leakage in shared clinical environments.
* **Print-Optimized**: Features a dedicated stylesheet for printing. Printing a disposition screen automatically hides navigation menus, sidebars, and non-essential UI elements to generate a clean, SOAP-note-ready document.
* **Section 508 Compliant**: Includes ARIA landmarks, skip-to-content links, focus-visible indicators, and optimized touch targets for accessibility.

## Deployment & Installation

Because ADTMC+ is a Progressive Web App (PWA) and a standalone file, it can be deployed in two primary ways:

### Method 1: "Install as App" (Recommended)
This repository is hosted via GitHub Pages. Users on modern browsers (Edge, Chrome) can install the app directly to their desktop:
1. Navigate to the live site: [https://matthewdholtkamp.github.io/ADTMCplus/](https://matthewdholtkamp.github.io/ADTMCplus/)
2. Click the **"Install ADTMC+"** icon in the right side of the address bar.
3. The app will download to the device, placing the application logo on the desktop. It will run in its own standalone window, independent of browser tabs.

### Method 2: Offline / Network Drive Deployment
Because the tool is entirely self-contained, it can be executed from a restricted government network drive or an air-gapped computer.
1. Download the repository files or the designated distribution ZIP.
2. Extract the files to the desired local or shared network folder.
3. Users can simply double-click the `index.html` file to open the tool in their default browser, completely offline.

---

### Clinical Disclaimer
*⚠ This tool is intended for use by trained military medical personnel only. It provides algorithm-directed clinical decision support and does not replace clinical judgment, provider evaluation, or established medical protocols. Users assume full responsibility for clinical decisions.*
