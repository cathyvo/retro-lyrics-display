// Retro Lyrics Display v1 - "Twinkle, Twinkle, Little Star"
// Press the button at the same moment the singing starts.

#include <LiquidCrystal.h>

// ----- Wiring -----
// LCD: RS=7, E=8, D4=9, D5=10, D6=11, D7=12
LiquidCrystal lcd(7, 8, 9, 10, 11, 12);
const int BUTTON_PIN = 2;  // other button leg goes to GND

// ----- Lyrics -----
// Each entry is one screen: a top row + a bottom row (16 characters max each)
const int LINE_COUNT = 6;

const char* topRow[LINE_COUNT] = {
  "Twinkle, twinkle",
  "How I wonder",
  "Up above the",
  "Like a diamond",
  "Twinkle, twinkle",
  "How I wonder"
};

const char* bottomRow[LINE_COUNT] = {
  "little star,",
  "what you are!",
  "world so high,",
  "in the sky.",
  "little star,",
  "what you are!"
};

// When each screen appears, in milliseconds after you press the button.
// 4000 ms per line is about 120 beats per minute. Tweak to match your recording.
const unsigned long lineTimes[LINE_COUNT] = {
  0, 4000, 8000, 12000, 16000, 20000
};

const unsigned long END_TIME = 24000;  // when the end screen appears

// ----- State (the board's "memory" between loops) -----
bool playing = false;         // is the song running right now?
unsigned long startTime = 0;  // millis() value when you pressed the button
int nextLine = 0;             // which screen comes next

// Helper: clear the LCD and show two rows of text
void showScreen(const char* top, const char* bottom) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(top);
  lcd.setCursor(0, 1);
  lcd.print(bottom);
}

void setup() {
  lcd.begin(16, 2);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  Serial.begin(9600);
  showScreen("Twinkle Twinkle", "Press to start");
}

void loop() {
  // 1. Not playing yet? Wait for a button press.
  if (!playing) {
    if (digitalRead(BUTTON_PIN) == LOW) {
      playing = true;
      startTime = millis();
      nextLine = 0;
      Serial.println("Started!");
    }
    return;  // end this pass of loop(); check again next pass
  }

  // 2. Playing: how long since the button press?
  unsigned long elapsed = millis() - startTime;

  // 3. Is it time for the next screen?
  if (nextLine < LINE_COUNT && elapsed >= lineTimes[nextLine]) {
    showScreen(topRow[nextLine], bottomRow[nextLine]);
    Serial.print("Line ");
    Serial.print(nextLine + 1);
    Serial.print(" at ");
    Serial.print(elapsed);
    Serial.println(" ms");
    nextLine++;
  }

  // 4. Song over? Show the end screen and get ready to replay.
  if (nextLine == LINE_COUNT && elapsed >= END_TIME) {
    showScreen("   ~ fin ~", "Press to replay");
    playing = false;
    delay(500);  // short pause so a held button doesn't restart it instantly
  }
}
