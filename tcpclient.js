const net = require('net');
const EventEmitter = require('events');

class TcpClient extends EventEmitter {
    constructor(host, port, options = {}) {
        super();
        this.host = host;
        this.port = port;
        this.options = options;

        this.log = options.log || console.log;

        this.connected = false;
        setImmediate(this.connect);
    }

    connect = () => {
        if (!this.connected)
            this.log(`Connecting to ${this.host}:${this.port}`)
        this.socket = new net.Socket();
        if (this.options.timeout)
            this.socket.setTimeout(this.options.timeout);

        this.socket.on('timeout', () => {
            this.reconnect();
        });
        this.socket.on('error', (err) => {
            this.reconnect();
        });
        this.socket.on('close', (err) => {
            this.log('Socket closed');
            this.reconnect();
        });
        this.socket.connect({ host: this.host, port: this.port }, () => {
            this.log(`Socket ${this.host}:${this.port} connected`);
            this.connected = true;
            this.emit('connect');
            this.socket.on('data', (rawdata) => {
                let data = rawdata.toString();
                this.log.debug('<< ', data);
                this.emit('data', data);
            });
        });
    }

    reconnect = () => {
        this.socket.removeAllListeners();
        this.socket.end();
        this.socket.destroy();
        if (this.connected == true) {
            this.log(`Socket ${this.host}:${this.port} disconnected`);
            this.connected = false;
            this.emit('disconnect');
        }
        setTimeout(this.connect, 1000);
    }
    send(data) {
        if (this.connected)
            this.socket.write(data);
        this.log.debug('>> ', data);
    }
}

module.exports = {
    TcpClient
}