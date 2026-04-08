# Photo parser

Create a tiny, max simple Python3 app for manual parsing of images in a windows folder

The app is started from cli and gets a local folder, then
- if destination folder exists, creates/checks there two folders: '__selected', '__dust';
- starts local web api server at localhost:1976
- starts a web browser at http://localhost:1976
- opens a single page app (see below)

Front-end single page app:
-  Angular v20 + Angular material design
- the page is vertically split into two parts: top (25vh) and bottom (75vh)
- the top part shows a list of images (.png,.jpeg, etc) found in the given folder, scrollable horizontally by arrow keys, currently selected image is bordered and always at the center
- the bottom part is splitted horizontally as 65vw + 35vw, whwere left part shows extracted file info (see below) and right section shows 100% size of the current image
- user can press delete key to move the current image to __dust (no confirm) or 'plus' key to move to __selected or left/right key to pass to next/prev image or ctrl+z to cancel last move

info to show
- name, last modif date, size
- for png files: extract Comphyui data : model, loras, prompt, steps (see ./run.py as example)
- for png and jepeg: metadata

app should be max simple and portable, as described