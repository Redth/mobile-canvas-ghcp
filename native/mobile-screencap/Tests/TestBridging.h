// Umbrella bridging header for the native HID test binary.
//
// The tests build the HID sources plus test-only fakes into their own executable, so no test code is
// linked into the shipped `mobile-screencap`.
#import "SimulatorDeviceBridge.h"
#import "SimulatorIndigoHid.h"
#import "SimulatorDtuHid.h"
#import "IndigoTestSupport.h"
