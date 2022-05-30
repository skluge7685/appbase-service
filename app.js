require('dotenv').config();
const { createLogger, format, transports } = require('winston');
const axios = require('axios');
var process = require('process');
var os 	= require('os-utils');
const crypto = require("crypto");
var amqp = require('amqplib/callback_api');
const { exit } = require('process');
var service_data = null;
var amqpConn = null;
var heartbeatIntervall = null;
var logger = null;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

initService();

//////////////////////////////////////////////
// Initilize Service
async function initService() {

    ////////////////////////////////////////////////////
    //Logger
    logger = createLogger({
        level: 'info',
        format: format.combine(format.timestamp({format: 'YYYY-MM-DD HH:mm:ss'}),format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)),
        transports: [
            new transports.Console({
                format: format.combine(format.colorize(), format.printf(function(info) {
                        
                    if(!Object.keys(info.additionalInfo).length) {
                        return `* ${info.timestamp} ${info.level}: [${info.tags}] ${info.message}`
                    } else {
                        return `* ${info.timestamp} ${info.level}: [${info.tags}] ${info.message} \n-> ${JSON.stringify(info.additionalInfo)}`
                    }
                })),
            }),
            new transports.Http({
                host: process.env.API_GATEWAY_HOST,
                path: '/service/report',
                method: 'POST',
                headers: {'Authorization': 'Bearer ' + process.env.API_GATEWAY_KEY}
            })
        ]
    })

    startService();
}

//////////////////////////////////////////////
// Connection to API Gateway
async function startService() {

    logger.log('info', 'Try to start service ....', {tags: 'START SERVICE', additionalInfo: {}});

    //Get System Informations
    var system_information = await getSystemInformation();

    //Get Maschine UUID
    const machineUuid = await require("machine-uuid")();

    ////////////////////////////////////////////////////
    //Register on API Gateway
    var register_data = {
        service_id: process.env.SERVICE_ID,
        service_process: machineUuid,
        system_information: system_information,
        routing_table: [
            {method: 'GET', path: '/location', description: 'Send a mail to receiver', servFunction: 'sendMail', authUser: true, authRessource: 'user', authAction: 'create', queryValidation: {"type": "object", "properties": {"zip": {"type": "string"}, "city": {"type": "string"}}, "required": ["zip", "city"], "additionalProperties": false}, bodyValidation: {}, invoicing: [{sku: '1', name: 'Test', price_net: 1.00, tax_percent: 19, quantity: 1}]},
        ]
    }
    axios.post(process.env.API_GATEWAY_SERVER + '/services/register', register_data, {headers: {'Authorization': 'Bearer ' + process.env.API_GATEWAY_KEY}})
    .then(async function(result) {
        
        //if Response is successfull
        if(result.data.code == 200) {

            service_data = result.data.data;
            
            logger.log('info', 'Sucessfull.', {tags: 'START SERVICE', service_token: service_data.service.token, additionalInfo: {}});

            //Start Custom Service Initialization
            try{
                service_data.custom_data = await require('./service_src/init.js').init(logger);
            } catch(e) {
                logger.log('error', 'Service custom init fail', {tags: 'START SERVICE', additionalInfo: e});
            }

            //Start AMQP Worker
            setTimeout(() => {
                startRabbitMQ();
            }, 5000);
            
            //Start Heartbeat
            heartbeatIntervall = setInterval(serviceHeartbeat, service_data.gateway.heartbeat);
        }
    })
    .catch(error => {
        logger.log('error', 'Service registration failed', {tags: 'START SERVICE', additionalInfo: {message: error.response.data.message}});

        //Restart Service
        logger.log('info', 'Restart in Progress ....', {tags: 'START SERVICE', additionalInfo: {}});
        setTimeout(() => {
            startService();
        }, 10000);

        return;
    })
}

//////////////////////////////////////////////
// Service Heartbeat Interval
async function serviceHeartbeat() {

    //Get System Informations
    var system_information = await getSystemInformation();

    axios.post(process.env.API_GATEWAY_SERVER + '/services/heartbeat', {service_token: service_data.service.token, system_information: system_information}, {headers: {'Accept': '*/*', 'Authorization': 'Bearer ' + process.env.API_GATEWAY_KEY, 'Content-Type': 'application/json'}})
    .then(result => {
        service_data.service.token = result.data.data.service_token;
    })
    .catch(error => {
        logger.log('error', 'failed', {tags: 'SERVICE HEARTBEAT', additionalInfo: {message: error.message}});

        //Reset
        service_data = null;
        clearInterval(heartbeatIntervall);
        amqpConn.close();

        //Restart Service
        logger.log('info', 'Restart in Progress ....', {tags: 'START SERVICE', additionalInfo: {}});
        setTimeout(() => {
            startService();
        }, 10000);
    })
}

function getSystemInformation() {

    return new Promise((resolve, reject) => {

        var system_information = {
            platform: os.platform(),
            free_mem_percent: os.freememPercentage(),
            service_uptime: os.processUptime(),
        }

        //CPU Usage
        os.cpuUsage(function(v){
            system_information.cpu_usage = v;

            resolve(system_information);
        });
    })
}

//////////////////////////////////////////////
// Connection to RabbitMQ
function startRabbitMQ() {

    if(amqpConn != null) { amqpConn.close(); }

    const opt = { credentials: require('amqplib').credentials.plain(service_data.amqp.user, service_data.amqp.password) };
    amqp.connect(service_data.amqp.host + "?heartbeat=60", opt, function(err, conn) {

        if (err) {
            logger.log('error', err.message, {tags: 'AMQP', additionalInfo: {message: error.message}});
            return setTimeout(startRabbitMQ, 10000);
        }

        conn.on("error", function(err) {
            if (err.message !== "Connection closing") {
                logger.log('warn', err.message, {tags: 'AMQP', additionalInfo: {message: error.message}});
            }
        });

        conn.on("close", function() {

            if(service_data != null) {
                logger.log('warn', 'Reconnection in progress ...', {tags: 'AMQP', additionalInfo: {}});
                return setTimeout(startRabbitMQ, 10000);
            }

        });

        logger.log('info', 'Connected.', {tags: 'AMQP', additionalInfo: {}});
        amqpConn = conn;

        AMQPWorker(service_data.amqp.queue);
    })
}

//////////////////////////////////////////////
// Message Queue Worker
function AMQPWorker(queue) {

    amqpConn.createChannel(function(err, ch) {

        if (closeOnErr(err)) return;

        ch.on("error", function(err) {
            logger.log('error', err.message, {tags: 'AMQP', additionalInfo: {message: error.message}});
        });

        ch.on("close", function() {
            logger.log('warn', 'Channel closed', {tags: 'AMQP', additionalInfo: {}});
        });

        var arguments = {};
        if(parseInt(process.env.SERVICE_MESSAGE_TTL) > 0) {
            arguments['x-message-ttl'] = parseInt(process.env.SERVICE_MESSAGE_TTL);
        }

        ch.assertQueue(queue, { durable: true, autoDelete: ((process.env.SERVICE_MESSAGE_AUTODELETE).toLowerCase() === 'true') || false, arguments: arguments }, function(err, _ok) {
            if (closeOnErr(err)) return;

            ch.consume(queue, processMsg, { noAck: false });
            logger.log('info', `Worker is started on Queue <${queue}>.`, {tags: 'AMQP', additionalInfo: {}});
        });

        async function processMsg(msg) {

            //Get Work Package
            const work_package = JSON.parse(msg.content.toString());
            
            //Wait for Resolution
            var response = await require('./service_src/router.js')(work_package, service_data, logger);
            
            //After Finish, send Response Message
            var response_json = JSON.stringify(response);
            ch.sendToQueue(msg.properties.replyTo, new Buffer.from(response_json), {correlationId: msg.properties.correlationId});
            ch.ack(msg);
        }
    })
}

//////////////////////////////////////////////
// AMQP Help Function
function closeOnErr(err) {

    if (!err) return false;

    console.log('[AMQP] Error -> ' + err.message);
    amqpConn.close();
    return true;
}

//////////////////////////////////////////////////////////////////////////////////////////////////////
//Exit Handler for Deregistration on API Gateway
async function exitHandler(options, exitCode) {

    console.log(''); console.log('');
    logger.log('info', 'in progress ............', {tags: 'SERVICE SHUTDOWN', additionalInfo: {}});

    //Stop Heartbeat
    clearInterval(heartbeatIntervall);
    
    //Deregister from API Gateway
    if(service_data != null) {
        try{
            await axios.delete(process.env.API_GATEWAY_SERVER + '/services/register', {service_token: service_data.service.token, exit_cause: exitCode}, {headers: {'Authorization': 'Bearer ' + process.env.API_GATEWAY_KEY, 'Content-Type': 'application/json'}})
        } catch(e) {
            console.log(e.message)
        }
    }
    
    //Kill Process
    logger.log('info', 'is done.', {tags: 'SERVICE SHUTDOWN', additionalInfo: {}});
    process.exit();
}

['SIGINT', 'SIGUSR1', 'SIGUSR2', 'uncaughtException', 'SIGTERM'].forEach((eventType) => {
    process.on(eventType, exitHandler.bind(null, {exit:true}));
})

