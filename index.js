"use strict";
const { API } = require('homebridge');
const tcp = require('./tcpclient');
const log = Math.log;
const average = arr => arr.reduce((a,b) => a + b, 0) / arr.length;
const secondsTillChangeCanHappen = 5
const degreesLimitBkp = 30
const lumenLimitBkp = 3000

module.exports = function (api) {
    api.registerAccessory("homebridge-analogreader",
        "Custom Light Controller", CustomLightSensorAccessory);
    api.registerAccessory("homebridge-thermal-analogreader",
        "Custom Wind Controller", 
        CustomThermalSensorAccessory);
};

class CustomThermalSensorAccessory {
    /** 
     * @param {*} log 
     * @param {*} config 
     * @param {API} api 
     */
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;

        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;

        this.accessories = [];

        // AccessoryInformation service
        this.informationService = new this.Service.AccessoryInformation()
            .setCharacteristic(this.api.hap.Characteristic.Manufacturer, "TE")
            .setCharacteristic(this.api.hap.Characteristic.Model, "SmartThermistor T1");
        this.accessories.push(this.informationService);
        this.log('[THERM] CREATED Information Service');

        // FAN service (Fan service type)
        this.fanService = new this.Service.Fan(this.config.name);
        this.fanService.getCharacteristic(this.Characteristic.On)
            .onGet(this.getFANStatus.bind(this))
            .onSet(this.setFAN.bind(this));
        this.accessories.push(this.fanService);
        this.log('CREATED Fan Service');

        // Temp sensor service
        this.tempSensorService = new this.Service.TemperatureSensor();
        this.tempSensorService.getCharacteristic(this.Characteristic.CurrentTemperature)
            .onGet(this.getTempLevel.bind(this));
        this.accessories.push(this.tempSensorService);
        this.log('CREATED TempSensor Service');

        // Properties for FAN and sensor (degrees of Celsium)
        this.onValueLevel = this.config.valueTriggerLimit || degreesLimitBkp;
        this.holdState = this.config.holdState || secondsTillChangeCanHappen;

        // Defaults
        // 
        this.fanCurrentState = false;
        this.currentTempValue = 1;
        this.initialRun = true
        this.block = false
        // Sensoric
        this.measurements = []
        this.userSet = false
        this.avg = undefined
        //ESP
        this.ESP_ip = this.config.ESP_ip || '192.168.0.11';
        this.ESP_port = 23; // const

        //TCP Client
        this.log('[THERM] Starting TCP Client');
        this.client = new tcp.TcpClient(this.ESP_ip, this.ESP_port, { log: this.log });
        this.client.on('data', this._onData);
        this.client.on('connect', this._onConnect);
        this.client.on('disconnect', this._onDisconnect);

        this.log('[THERM] Custom accesory is Created!');
    }


    getServices() {
        return this.accessories;
    }

    async getFANStatus() {
        this.log.debug('FAN Status GET', this.fanCurrentState);
        // this.log('FAN Status GET', this.fanCurrentState);
        return this.fanCurrentState;
    }

    async setFAN(value, fromSensor) {
        // from sensor
        if (fromSensor) {
            this.userSet = false
            this.measurements = []
        // from UI
        } else {
            this.userSet = value
        }

        // Send to DEVICE
        if (this.client.connected) {
            this.fanCurrentState = value
            this.isOn = value

            this.client.send(value ? 'R31\n' : 'R30\n');
        } else {
            this.log.warn('[THERM] TCP Client not connected');
        }
    }
    async getTempLevel() {
        this.log.debug('GET TempLevel');
        return this.currentTempValue;
    }

    _onConnect = () => {
        //todo, zatial netreba 
    }
    _onDisconnect = () => {
        //todo, zatial netreba
    }
    /**
     * 
     * @param {String} data 
     */
    _onData = (data) => {
        // prevent overfilling
        if (this.block === true)
            return
        this.block = true

        let cmd = data[0];
        //Skip
        if (cmd === '\n' || cmd === '\r') {
            this.block = false
            return;
        }
        //this.log('[THERM] Data >> ', data);

        let msg = data.slice(1);
        if (cmd === 'A') {
            let params = msg.split(' ');
            this.currentTempValue = this.toCelsius(parseInt(params[0].slice(1)));

            // change value in UI - never change fanStatus here!
            this.tempSensorService.setCharacteristic(this.Characteristic.CurrentTemperature, this.currentTempValue);

            this.processValue(this.currentTempValue)
            //this.log(`[THERM] ${this.currentTempValue}`);
        }
        if (cmd === 'R') {
            let relay = msg[0];
            if (relay === '3') {
                this.fanCurrentState = msg[1] == '1' ? true : false;
            }
        }

        // free
        this.block = false
    }

    async processValue(temp) {
        // prevent FAN being ON from last run
        if (this.initialRun) {
            this.initialRun = false
            await this.setFAN(false)
            return
        }

        // Make sure last X measurements are present
        this.measurements.push(temp)
        if (this.measurements.length > this.holdState) {
            this.measurements.shift()
        }
        this.avg = (this.measurements.length === this.holdState) ? average(this.measurements) : undefined
        this.log(`AVG TEMP: ${this.avg}`)

        // if Average is present
        //      && If User did not specify value
        //             => We can track changes
        if (this.avg !== undefined && this.userSet === false) {
            
            // turn ON the FAN when too hot (for extended period of time)
            if (this.avg >= this.onValueLevel && this.fanCurrentState === false) {
                this.log(` zapinam FAN `)

                // 2nd param present ===  origin from sensor
                await this.setFAN(true, true)
            
            // turn OFF the FAN when too bright (for extended period of time)
            } else if (this.avg < this.onValueLevel && this.fanCurrentState === true) {
                this.log(` vypinam FAN `)

                // 2nd param present ===  origin from sensor
                await this.setFAN(false, true)
            }

            // absolutely necessary
            await this.getFANStatus()
            await this.fanService.setCharacteristic(this.Characteristic.On, this.fanCurrentState)
            this.userSet = false
        }
    }

    /* 
        hot > 30
        ok < 30 degrees
    */
    toCelsius = (analogValue) => {
        // attempt 0
        let RT0 = 100000;   // 100kΩ
        let B = 3950;      // K
            
            
        let VCC = 5;    //Supply voltage
        let R = 10000;  //R=10kΩ
            
        //Variables
        let RT, VR, ln, TX, T0, VRT;
        T0 = 30 + 273.15;                 //Temperature T0 from datasheet, conversion from Celsius to kelvin

        
        VRT = analogValue // from args
        // calc
        VRT = (VCC / 1023.00) * VRT;      //Conversion to voltage
        VR = VCC - VRT;
        RT = VRT / (VR / R);               //Resistance of RT
        
        ln = log(RT / RT0);
        TX = (1 / ((ln / B) + (1 / T0))); //Temperature from thermistor
        
        return (TX - 273.15) > 100 ? 100 : (TX - 273.15);
    }
}

class CustomLightSensorAccessory {
    /** 
     * @param {*} log 
     * @param {*} config 
     * @param {API} api 
     */
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;

        this.accessories = [];

        // AccessoryInformation service
        this.informationService = new this.Service.AccessoryInformation()
            .setCharacteristic(this.api.hap.Characteristic.Manufacturer, "ME")
            .setCharacteristic(this.api.hap.Characteristic.Model, "SmartLED M1");
        this.accessories.push(this.informationService);
        this.log('[LIGHT] CREATED Information Service');

        // LED service (Lightbulb service type)
        this.ledService = new this.Service.Lightbulb(this.config.name);
        this.ledService.getCharacteristic(this.Characteristic.On)
            .onGet(this.getLEDStatus.bind(this))
            .onSet(this.setLED.bind(this));
        this.accessories.push(this.ledService);
        this.log('CREATED LED Service');

        // Light sensor service
        this.lightSensorService = new this.Service.LightSensor();
        this.lightSensorService.getCharacteristic(this.Characteristic.CurrentAmbientLightLevel)
            .onGet(this.getLightLevel.bind(this));
        this.accessories.push(this.lightSensorService);
        this.log('CREATED LightSensor Service');

        // Properties for LED and sensor - in lumens (lux is presented, not accurate as that is dependend on various things)
        this.onValueLevel = this.config.valueTriggerLimit || lumenLimitBkp
        this.holdState = this.config.holdState || secondsTillChangeCanHappen;

        // Defaults
        // 
        this.ledCurrentState = false;
        this.currentLightValue = 1;
        this.initialRun = true
        this.block = false
        // Sensoric
        this.measurements = []
        this.userSet = false
        this.avg = undefined
        // ESP
        this.ESP_ip = this.config.ESP_ip || '192.168.0.10';
        this.ESP_port = 23;

        // TCP Client
        this.log('[LIGHT] Starting TCP Client');
        this.client = new tcp.TcpClient(this.ESP_ip, this.ESP_port, { log: this.log });
        this.client.on('data', this._onData);
        this.client.on('connect', this._onConnect);
        this.client.on('disconnect', this._onDisconnect);

        this.log('[LIGHT] Custom accesory is Created!');
    }

    getServices() {
        return this.accessories;
    }

    async getLEDStatus() {
        this.log.debug('LED Status GET', this.ledCurrentState);
        // this.log('LED Status GET', this.ledCurrentState);
        return this.ledCurrentState;
    }

    /* when called from Homebridge UI - fromSensor is undefined */
    async setLED(value, fromSensor) {
        // from sensor
        if (fromSensor) {
            this.userSet = false
            this.measurements = []
        // from UI 
        } else {
            this.userSet = value
        }
        

        // Send to DEVICE
        if (this.client.connected) {
            this.ledCurrentState = value
            this.isOn = value

            this.client.send(value ? 'R31\n' : 'R30\n');
        } else {
            this.log.warn('[LIGHT] TCP Client not connected');
        }
    }
    async getLightLevel() {
        this.log.debug('GET LightLevel');
        return this.currentLightValue;
    }

    _onConnect = () => {
        //todo, zatial netreba 
    }
    _onDisconnect = () => {
        //todo, zatial netreba
    }
    /**
     * 
     * @param {String} data 
     */
    _onData = (data) => {
        // prevent overfilling
        if (this.block === true)
            return
        this.block = true
        
        let cmd = data[0];
        //Skip
        if (cmd === '\n' || cmd === '\r') {
            this.block = false
            return;
        }
        //this.log('[LIGHT] Data >> ', data);

        let msg = data.slice(1);
        if (cmd === 'A') {
            let params = msg.split(' ');
            this.currentLightValue = this.toLux(parseInt(params[0].slice(1))); 

            // change value in UI - never change ledStatus here!
            this.lightSensorService.setCharacteristic(this.Characteristic.CurrentAmbientLightLevel, this.currentLightValue);

            this.processValue(this.currentLightValue)
            //this.log(this.currentLightValue);
        }
        if (cmd === 'R') {
            let relay = msg[0];
            if (relay === '3') {
                this.ledCurrentState = msg[1] == '1' ? true : false;
            }
        }

        // free
        this.block = false
    }

    async processValue(light) {

        // prevent LED from being ON from last run
        if (this.initialRun) {
            this.initialRun = false
            await this.setLED(false)
            return
        }

        // this.log(`Davam light: ${light}`)
        
        // Make sure last 50 measurements are present
        this.measurements.push(light)
        if (this.measurements.length > this.holdState) {
            this.measurements.shift()
        }
        this.avg = (this.measurements.length === this.holdState) ? average(this.measurements) : undefined
        this.log(`AVG LIGHT: ${this.avg}`)

        // if Average is present
        //      && If User did not specify value
        //             => We can track changes
        if (this.avg !== undefined && this.userSet === false) {
            //this.log(`this.avg !== undefined && this.userSet === false`)
            
            // turn ON the LED when too dimm (for extended period of time)
            // this.log(`${this.avg} | ${this.onValueLevel} | ${this.ledCurrentState}`)
            if (this.avg <= this.onValueLevel && this.ledCurrentState === false) {
                this.log(` zapinam LED `)

                // 2nd param present ===  origin from sensor
                await this.setLED(true, true)
            
            // turn OFF the LED when too bright (for extended period of time)
            } else if (this.avg > this.onValueLevel && this.ledCurrentState === true) {
                this.log(` vypinam LED `)

                // 2nd param present ===  origin from sensor
                await this.setLED(false, true)
            }

            // absolutely necessary
            await this.getLEDStatus()
            await this.ledService.setCharacteristic(this.Characteristic.On, this.ledCurrentState)
            this.userSet = false
        }
    }
    /* 
        dark indoors - 125
        normal indoors - 700
        bright indoors - 3000
        outdoors (dim - direct) = 7500 - 20 000 - sensor limitation
    */
    toLux = (analogValue) => { 
        // more accurate version (because LDR is non linear and photodiode would be better)
        var VIN = 3.3
        var R = 1000000.0 // Mega OHM at 0
        var Vout = analogValue * (VIN / 1024.0)
        var RLDR = (R * (VIN - Vout))/VIN;
        
        var test = (R-RLDR)/R * 10000 / (VIN - Vout)
        
        // secure tresholds
        if (test > 100000) {
            return 100000.0
        }
        if (test < 0.001) {
            return 0.001
        }
        return test
        
        // simpler
        //return Math.round(analogValue/1023.0 * 20000.0, 6)
    }
}