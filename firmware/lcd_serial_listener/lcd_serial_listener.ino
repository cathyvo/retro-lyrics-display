// LCD Listener - v2, Step 3
// The Uno waits for text from the PC over USB and shows it on the LCD.
// Message format (one line per screen):   top row text|bottom row text

#include <LiquidCrystal.h>

// ----- Wiring -----
// LCD: RS=7, E=8, D4=9, D5=10, D6=11, D7=12
LiquidCrystal lcd(7, 8, 9, 10, 11, 12);

// Helper: clear the LCD and show two rows of text
void showScreen(String top, String bottom) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(top);
  lcd.setCursor(0, 1);
  lcd.print(bottom);
}

void setup() {
  lcd.begin(16, 2);
  Serial.begin(9600);          // open the USB "text line" to the PC
  showScreen("Waiting for PC", "...");
}

void loop() {
  // Is a message waiting in the mailbox?
  if (Serial.available() > 0) {
    String msg = Serial.readStringUntil('\n');  // read one line
    msg.trim();                                 // remove hidden characters at the ends

    int bar = msg.indexOf('|');                 // where's the divider? (-1 = not found)
    String top;
    String bottom;

    if (bar != -1) {
      top = msg.substring(0, bar);              // text before the |
      bottom = msg.substring(bar + 1);          // text after the |
    } else {
      top = msg;                                // no | : whole message on the top row
      bottom = "";
    }

    showScreen(top, bottom);
  }
}
