JOKER BLUFF - Las Vegas casino design

1) Check everything works:     npm test      (expect: fail 0)
2) Start the game:             npm start
3) Open in your browser:       http://localhost:3000

For friends over the internet, in a second terminal:
    cloudflared tunnel --url http://localhost:3000
Open the https link it prints, create a room, and send the invite link.

Files: src/ = game rules and server, public/ = the website (index.html, style.css, app.js).
