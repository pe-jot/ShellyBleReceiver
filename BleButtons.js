/*******************************************************************************
 * DESCRIPTION:
 * Receive BLE advertisement data from Shelly BLU RC Button 4 and control lights
 *******************************************************************************
 * DOCUMENTATION AND EXAMPLES:
 * https://bthome.io/format/
 * https://shelly-api-docs.shelly.cloud/docs-ble/common/
 * https://shelly-api-docs.shelly.cloud/docs-ble/Devices/BLU/wall_us
 * https://shelly-api-docs.shelly.cloud/gen2/General/ComponentConcept/
 * https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Shelly/
 * https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Light
 * https://shelly-api-docs.shelly.cloud/gen2/Scripts/APIs/BLE
 * https://shelly-api-docs.shelly.cloud/gen2/Scripts/APIs/Shelly
 * https://shelly-api-docs.shelly.cloud/gen2/Scripts/Tutorial/#step-3-handle-button-presses
 ******************************************************************************/

const CONFIG = {
	LOCK_DELAY: 600,				// Lock time before another action is allowed - to avoid unintended double actions
	BLE_ADDR: "aa:bb:cc:dd:ee:ff",	// The sender's BLE MAC address can be found e.g. with the Shelly BLE Debug app
	DEBUG: false,				 	// Enable debug log messages
	BUTTONS: 4,						// Number of buttons to expect
	LED_CHANNEL: 3					// 0..3
};

const SCAN_PARAM = {
	duration_ms: BLE.Scanner.INFINITE_SCAN,
	active: false,
	interval_ms: 60,
	window_ms: 20,
    filters: [
        {
            addrs: [ CONFIG.BLE_ADDR ]
        }
    ]
};

const BRIGHTNESS_STEPS = [ 1, 20, 50, 100 ]; // One brightness for each button

const EXPECTED_FRAME_LENGTH = 20;

const EXPECTED_HEADER = [
	0x02, 0x01, 0x06, 0x10, 0x16, 0xd2, 0xfc, 0x44
//  |     |           |     |     |           |
//  |     |           |     |     |           BTHome Device Information
//  |     |           |     |     BTHome UUID
//  |     |           |     Service Data
//  |     |           Length
//  |     Flags (AD type + data)
//  Length
];

let gDebounceLock = false;
let gLastDimDirectionUp = true;

function scanCallback(ev, res) {
	if (ev !== BLE.Scanner.SCAN_RESULT) {
		return;
	}
	if (res.addr !== CONFIG.BLE_ADDR) {
		return;
	}

	debugLog("Lock status: " + gDebounceLock);
	if (gDebounceLock === true) {
		return;
	}
	
	debugLog("ev: " + JSON.stringify(ev));
	debugLog("Address: " + res.addr + ", Name: " + res.local_name + ", RSSI: " + res.rssi + ", addr_type: " + res.addr_type + ", advData.length: " + res.advData.length + ", advData: " + btoh(res.advData));
	
	// We expect a fixed frame length for simplicity
	if (res.advData.length !== EXPECTED_FRAME_LENGTH) {
		console.log("Error: Frame length mismatch!");
		return;
	}
	
	// Simply check all the BLE + BTHome headers
	for (let i = 0; i < EXPECTED_HEADER.length; i++) {
		if (res.advData.charCodeAt(i) !== EXPECTED_HEADER[i]) {
			console.log("Error: Frame header mismatch!");
			debugLog(" [" + i + "] expected: " + EXPECTED_HEADER[i] + " actual: " + res.advData.charCodeAt(i))
			return;
		}
	}
	
	let currentButton = 0;
	let buttonData = new Array(CONFIG.BUTTONS);
	for (let i = 0; i < CONFIG.BUTTONS; i++) {
		buttonData[i] = 0;
	}
	
	// Parse service data
	for (let i = EXPECTED_HEADER.length; i < EXPECTED_FRAME_LENGTH; i++) {
		let itemType = res.advData.charCodeAt(i++);
		switch (itemType)
		{
		case 0x00:  // Packet ID
			let packetId = res.advData.charCodeAt(i);
			debugLog("PacketID: " + packetId);
			break;

		case 0x01:  // Battery level
			let batteryLevel = res.advData.charCodeAt(i);
			debugLog("Battery: " + batteryLevel);
			break;

		case 0x3A:  // Button event
			let buttonEvent = res.advData.charCodeAt(i);
			buttonData[currentButton] = buttonEvent;
			currentButton++;
			currentButton %= CONFIG.BUTTONS;
			break;

		default:    // Unknown
			console.log("Error: Unknown BLE frame data (" + itemType + ")!");
			return;
		}
	}
	
	if (CONFIG.DEBUG) {
		let status = Shelly.getComponentStatus("light", CONFIG.LED_CHANNEL);
		if (status) {
			console.log("Light", CONFIG.LED_CHANNEL, "is currently", status.output ? "ON" : "OFF", "Brightness", status.brightness, "%");
		}
	}
	
	handleButtonPresses(buttonData);
}

function handleButtonPresses(buttonData) {
	for (let i = 0; i < CONFIG.BUTTONS; i++) {
		switch (buttonData[i]) {
			case 0x00:
				debugLog("Button " + (i + 1) + " released");
				break;
				
			case 0x01:
				debugLog("Button " + (i + 1) + " single press");
				// On a single click, all buttons behave the same: toggle light on/off
				Shelly.call("Light.Toggle", { id: CONFIG.LED_CHANNEL });
				acquireLock();
				return; // We return here because we aren't interested in any other button states anymore
				
			case 0x02:
				debugLog("Button " + (i + 1) + " double press");
				// Depending on the button pressed, we get the associated brightness from the lookup table
				Shelly.call("Light.Set", { id: CONFIG.LED_CHANNEL, on: true, brightness: BRIGHTNESS_STEPS[i] });
				acquireLock();
				return; // We return here because we aren't interested in any other button states anymore
				
			case 0x03:
				debugLog("Button " + (i + 1) + " triple press");
				break;
				
			case 0x04:
				debugLog("Button " + (i + 1) + " long press");
				break;
				
			case 0x80:
				debugLog("Button " + (i + 1) + " hold");
				break;
		}
	}
}

/* __UNUSED__ */ function dim() {
	let status = Shelly.getComponentStatus("light", CONFIG.LED_CHANNEL);
	if (status === null) {
		return;
	}
	if (status.output === "OFF") {
		Shelly.call("Light.Set", { id: CONFIG.LED_CHANNEL, on: true, brightness: 1 });
		Shelly.call("Light.DimUp", { id: CONFIG.LED_CHANNEL });
		gLastDimDirectionUp = true;
	}
	else if (gLastDimDirectionUp === true) {
		Shelly.call("Light.DimDown", { id: CONFIG.LED_CHANNEL });
		gLastDimDirectionUp = false;		
	}
	else {		
		Shelly.call("Light.DimUp", { id: CONFIG.LED_CHANNEL });
		gLastDimDirectionUp = true;		
	}
}

function debugLog(message) {
	// Unfortunately we cannot use ...args parameter in a Shelly Script function, so we need to fall back to conventional string concatenation
	if (CONFIG.DEBUG) {
		console.log(message);
	}
}

function acquireLock() {
	gDebounceLock = true;
	Timer.set(CONFIG.LOCK_DELAY, 0, releaseLock);
}

function releaseLock() {
	gDebounceLock = false;
}

function init() {
	// Check if the scanner is already running
	if (BLE.Scanner.isRunning()) {
		console.log("Info: The BLE gateway is running, the BLE scan configuration is managed by the device");
		return;
	}
	// Start the scanner
	const bleScanner = BLE.Scanner.Start(SCAN_PARAM, scanCallback);
	if (!bleScanner) {
		console.log("Error: Can not start new scanner");
	}
	else {
		debugLog("BLE scanner started");
	}
}

init();
